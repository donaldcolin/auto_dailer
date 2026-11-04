const supabase = require('../config/supabase');
const { lsqClient, lsqUrl } = require('../config/lsq');
const { activeRuleFor, istNow } = require('./rules');
const { fetchPushes, pendingPushes } = require('./pushed');
const { activityEventFor } = require('./activity');

const LIST_CACHE_MS = 5 * 60 * 1000;
const PUSH_CACHE_MS = 60 * 1000; // a TL's push reaches the queue within a minute
const PAGE_SIZE = 200;
// Shown on the call screen when filled (picked from HR leads, 2026-11-04; LSQ lead fields are org-wide).
const DETAIL_COLUMNS = 'Source,SourceMedium,SourceCampaign,mx_District,mx_State,mx_Total_Calls,mx_Total_Connects,mx_Last_Spoken_On,LeadAge';
const COLUMNS = `ProspectID,FirstName,LastName,Phone,Mobile,ProspectStage,OwnerId,${DETAIL_COLUMNS}`;
// Converted or ruled-out leads: never in the default queue. A TL rule can still target them on purpose.
const SKIP_BY_DEFAULT = new Set(['Signup Done', 'Payment Done', 'Customer', 'Disqualified']);
// HR keeps every candidate in one stage ("HR New Lead") and records outcomes in HR Activity, so its default
// queue is the candidates nobody has spoken to yet (Donald, 2026-11-04). Unanswered ones return on later days.
const HR_EVENT = 263;
const keepByDefault = profile => (activityEventFor(profile) === HR_EVENT
  ? l => !l.connects
  : l => !SKIP_BY_DEFAULT.has(l.stage));
// One HR associate owns ~7,700 leads; reading them all takes over a minute and trips LSQ's rate limit.
// So the default queue stops at the newest MAX_QUEUE dialable leads (2 days of ~150 dials).
// shortcut: and reads at most MAX_PAGES pages (2,000 newest leads); older open leads need a TL push or rule.
const MAX_QUEUE = 300;
const MAX_PAGES = 10;

// shortcut: per-process cache, fine with one backend instance; move to a shared store if it's scaled out.
const _cache = new Map(); // 'list:<id>' | 'owner:<lsqUserId>' | 'pushes' | 'lead:<id>' -> { leads, expires } or { pending }

const istTime = s => new Date(`${s.replace(' ', 'T')}Z`) // LSQ dates are UTC "YYYY-MM-DD HH:mm:ss"
  .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// What the caller sees about a lead before and after the call, as label/value rows; empty fields are left out.
function details(p) {
  const out = [];
  const add = (label, ...values) => {
    const value = [...new Set(values.filter(v => v && v !== '0'))].join(', ');
    if (value) out.push({ label, value });
  };
  add('Source', p.Source, p.SourceMedium);
  add('Campaign', p.SourceCampaign);
  add('Location', p.mx_District, p.mx_State);
  if (Number(p.mx_Total_Calls)) add('Calls', `${p.mx_Total_Calls} made, ${p.mx_Total_Connects || 0} connected`);
  if (p.mx_Last_Spoken_On) add('Last spoke', istTime(p.mx_Last_Spoken_On));
  if (Number(p.LeadAge)) add('Lead age', `${p.LeadAge} ${p.LeadAge === '1' || p.LeadAge === 1 ? 'day' : 'days'}`);
  return out;
}

// List reads return { LeadPropertyList: [{ Attribute, Value }] }; Leads.Get returns flat objects.
const toLead = row => {
  const p = row.LeadPropertyList ? Object.fromEntries(row.LeadPropertyList.map(x => [x.Attribute, x.Value])) : row;
  return {
    prospectId: p.ProspectID,
    name: [p.FirstName, p.LastName].filter(Boolean).join(' '),
    phone: p.Mobile || p.Phone || null,
    stage: p.ProspectStage,
    ownerId: p.OwnerId,
    connects: Number(p.mx_Total_Connects) || 0,
    details: details(p),
  };
};

// Every lead in a dynamic List. Page 1 asks LSQ to recalculate the List; later pages reuse that result.
async function readList(listId) {
  const leads = [];
  for (let page = 1; ; page++) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads/Retrieve/BySearchParameter'), {
      SearchParameters: { ListId: listId, RetrieveBehaviour: page === 1 ? '1' : '0' },
      Columns: { Include_CSV: COLUMNS },
      Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data.Leads || [];
    leads.push(...rows.map(toLead));
    if (rows.length < PAGE_SIZE || leads.length >= data.RecordCount) return leads;
  }
}

// The newest leads an LSQ user owns that `keep` accepts and that have a phone, up to MAX_QUEUE.
async function readOwnedLeads(lsqUserId, keep) {
  const leads = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads.Get'), {
      Parameter: { LookupName: 'OwnerId', LookupValue: lsqUserId, SqlType: 'uniqueidentifier' },
      Columns: { Include_CSV: COLUMNS },
      Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data || [];
    leads.push(...rows.map(toLead).filter(l => l.phone && keep(l)));
    if (rows.length < PAGE_SIZE || leads.length >= MAX_QUEUE) break;
  }
  return leads.slice(0, MAX_QUEUE);
}

// One lead by id (null if LSQ has none), for pushes: a pushed lead may be far older than the default queue reaches.
async function readLead(id) {
  const { data } = await lsqClient.get(`${lsqUrl('LeadManagement.svc/Leads.GetById')}&id=${encodeURIComponent(id)}`);
  return data?.[0] ? toLead(data[0]) : null;
}

// One LSQ read every few minutes per key; concurrent callers share it.
function cached(key, load, ttl = LIST_CACHE_MS, now = Date.now()) {
  const hit = _cache.get(key);
  if (hit && 'leads' in hit && hit.expires > now) return Promise.resolve(hit.leads);
  if (hit?.pending) return hit.pending;
  const pending = load()
    .then(leads => { _cache.set(key, { leads, expires: Date.now() + ttl }); return leads; })
    .catch(err => { _cache.delete(key); throw err; });
  _cache.set(key, { pending });
  return pending;
}

// A List serves the whole team, so it's cached once for everyone on it.
const getListLeads = listId => cached(`list:${listId}`, () => readList(listId));
const getOwnedLeads = profile => cached(`owner:${profile.lsq_user_id}`, () => readOwnedLeads(profile.lsq_user_id, keepByDefault(profile)));
const getPushes = () => cached('pushes', () => fetchPushes(), PUSH_CACHE_MS);
const getLead = id => cached(`lead:${id}`, () => readLead(id));

// The caller's own leads with a phone number, minus the ones already dialed.
function ownQueue(leads, ownerId, dialedIds) {
  return leads.filter(l => l.ownerId === ownerId && l.phone && !dialedIds.has(l.prospectId));
}

// Leads a TL pushed (Auto Dialer activity) to this associate's leads, not dialed since the push.
// shortcut: reads each pushed lead by id (cached 5 min); fine at a few pushes a week, batch it if pushes reach hundreds.
async function getPushedLeads(profile) {
  const all = await getPushes();
  const leads = (await Promise.all([...new Set(all.map(p => p.prospectId))].map(getLead)))
    .filter(l => l && l.ownerId === profile.lsq_user_id);
  const mine = new Set(leads.map(l => l.prospectId));
  const pushes = all.filter(p => mine.has(p.prospectId));
  if (!pushes.length) return [];
  const oldest = pushes.reduce((m, p) => (p.pushedAt < m ? p.pushedAt : m), pushes[0].pushedAt);
  const { data: attempts, error } = await supabase.from('dial_attempts').select('prospect_id, started_at')
    .eq('user_id', profile.id).in('prospect_id', [...new Set(pushes.map(p => p.prospectId))]).gte('started_at', oldest);
  if (error) throw error;
  return pendingPushes(pushes, leads, attempts);
}

/**
 * Leads a TL pushed come first. Then, by default, the newest leads the caller owns in LSQ (minus closed
 * stages; for HR, minus anyone already spoken to); a TL rule active right now replaces that part with its List.
 * `fresh` skips the LSQ caches for this caller.
 */
async function getQueue(profile, now = new Date(), { fresh = false } = {}) {
  const rule = await activeRuleFor(profile, now);
  // "Refresh leads" in the app: re-read LSQ now instead of waiting out the caches (new pushes, newly assigned leads).
  if (fresh) {
    ['pushes', `owner:${profile.lsq_user_id}`, rule && `list:${rule.list_id}`].forEach(k => k && _cache.delete(k));
    for (const k of _cache.keys()) if (k.startsWith('lead:')) _cache.delete(k);
  }

  let dialedToday = supabase.from('dial_attempts').select('prospect_id')
    .eq('user_id', profile.id).gte('started_at', istNow(now).midnightIso);
  dialedToday = rule ? dialedToday.eq('rule_id', rule.id) : dialedToday.is('rule_id', null);

  const [leads, { data: dialed, error }, pushed] = await Promise.all([
    rule ? getListLeads(rule.list_id) : getOwnedLeads(profile),
    dialedToday,
    getPushedLeads(profile),
  ]);
  if (error) throw error;

  const pushedIds = new Set(pushed.map(l => l.prospectId));
  const rest = ownQueue(leads, profile.lsq_user_id, new Set(dialed.map(d => d.prospect_id)))
    .filter(l => !pushedIds.has(l.prospectId));

  return {
    source: rule ? 'rule' : 'own',
    rule: rule && { id: rule.id, listName: rule.list_name, startTime: String(rule.start_time).slice(0, 5) },
    pushedCount: pushed.length,
    leads: [...pushed, ...rest].map(({ ownerId, connects, ...lead }) => lead),
  };
}

module.exports = { details, getQueue, getListLeads, getOwnedLeads, ownQueue, readList };
