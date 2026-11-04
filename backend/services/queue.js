const supabase = require('../config/supabase');
const { lsqClient, lsqUrl } = require('../config/lsq');
const { activeRuleFor, istNow } = require('./rules');
const { fetchPushes, pendingPushes } = require('./pushed');

const LIST_CACHE_MS = 5 * 60 * 1000;
const PUSH_CACHE_MS = 60 * 1000; // a TL's push reaches the queue within a minute
const PAGE_SIZE = 200;
const COLUMNS = 'ProspectID,FirstName,LastName,Phone,Mobile,ProspectStage,OwnerId';
// Converted or ruled-out leads: never in the default queue. A TL rule can still target them on purpose.
const SKIP_BY_DEFAULT = new Set(['Signup Done', 'Payment Done', 'Customer', 'Disqualified']);

// shortcut: per-process cache, fine with one backend instance; move to a shared store if it's scaled out.
const _cache = new Map(); // 'list:<id>' | 'owner:<lsqUserId>' | 'pushes' -> { leads, expires } or { pending }

// List reads return { LeadPropertyList: [{ Attribute, Value }] }; Leads.Get returns flat objects.
const toLead = row => {
  const p = row.LeadPropertyList ? Object.fromEntries(row.LeadPropertyList.map(x => [x.Attribute, x.Value])) : row;
  return {
    prospectId: p.ProspectID,
    name: [p.FirstName, p.LastName].filter(Boolean).join(' '),
    phone: p.Mobile || p.Phone || null,
    stage: p.ProspectStage,
    ownerId: p.OwnerId,
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

// Every lead an LSQ user owns, newest first.
async function readOwnedLeads(lsqUserId) {
  const leads = [];
  for (let page = 1; ; page++) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads.Get'), {
      Parameter: { LookupName: 'OwnerId', LookupValue: lsqUserId, SqlType: 'uniqueidentifier' },
      Columns: { Include_CSV: COLUMNS },
      Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data || [];
    leads.push(...rows.map(toLead));
    if (rows.length < PAGE_SIZE) return leads;
  }
}

// One LSQ read every few minutes per key; concurrent callers share it.
function cached(key, load, ttl = LIST_CACHE_MS, now = Date.now()) {
  const hit = _cache.get(key);
  if (hit?.leads && hit.expires > now) return Promise.resolve(hit.leads);
  if (hit?.pending) return hit.pending;
  const pending = load()
    .then(leads => { _cache.set(key, { leads, expires: Date.now() + ttl }); return leads; })
    .catch(err => { _cache.delete(key); throw err; });
  _cache.set(key, { pending });
  return pending;
}

// A List serves the whole team, so it's cached once for everyone on it.
const getListLeads = listId => cached(`list:${listId}`, () => readList(listId));
const getOwnedLeads = lsqUserId => cached(`owner:${lsqUserId}`, () => readOwnedLeads(lsqUserId));
const getPushes = () => cached('pushes', () => fetchPushes(), PUSH_CACHE_MS);

// The caller's own leads with a phone number, minus the ones already dialed.
function ownQueue(leads, ownerId, dialedIds) {
  return leads.filter(l => l.ownerId === ownerId && l.phone && !dialedIds.has(l.prospectId));
}

// Leads a TL pushed (Auto Dialer activity) that this associate hasn't dialed since the push.
async function getPushedLeads(profile, owned) {
  const mine = new Set(owned.map(l => l.prospectId));
  const pushes = (await getPushes()).filter(p => mine.has(p.prospectId));
  if (!pushes.length) return [];
  const oldest = pushes.reduce((m, p) => (p.pushedAt < m ? p.pushedAt : m), pushes[0].pushedAt);
  const { data: attempts, error } = await supabase.from('dial_attempts').select('prospect_id, started_at')
    .eq('user_id', profile.id).in('prospect_id', [...new Set(pushes.map(p => p.prospectId))]).gte('started_at', oldest);
  if (error) throw error;
  return pendingPushes(pushes, owned, attempts);
}

/**
 * Leads a TL pushed come first. Then, by default, every lead the caller owns in LSQ
 * (minus closed stages); a TL rule active right now narrows that part to the rule's List.
 * `fresh` skips the LSQ caches for this caller.
 */
async function getQueue(profile, now = new Date(), { fresh = false } = {}) {
  const rule = await activeRuleFor(profile, now);
  // "Refresh leads" in the app: re-read LSQ now instead of waiting out the caches (new pushes, newly assigned leads).
  if (fresh) ['pushes', `owner:${profile.lsq_user_id}`, rule && `list:${rule.list_id}`].forEach(k => k && _cache.delete(k));

  let dialedToday = supabase.from('dial_attempts').select('prospect_id')
    .eq('user_id', profile.id).gte('started_at', istNow(now).midnightIso);
  dialedToday = rule ? dialedToday.eq('rule_id', rule.id) : dialedToday.is('rule_id', null);

  const owned = await getOwnedLeads(profile.lsq_user_id);
  const [leads, { data: dialed, error }, pushed] = await Promise.all([
    rule ? getListLeads(rule.list_id) : owned.filter(l => !SKIP_BY_DEFAULT.has(l.stage)),
    dialedToday,
    getPushedLeads(profile, owned),
  ]);
  if (error) throw error;

  const pushedIds = new Set(pushed.map(l => l.prospectId));
  const rest = ownQueue(leads, profile.lsq_user_id, new Set(dialed.map(d => d.prospect_id)))
    .filter(l => !pushedIds.has(l.prospectId));

  return {
    source: rule ? 'rule' : 'own',
    rule: rule && { id: rule.id, listName: rule.list_name, startTime: String(rule.start_time).slice(0, 5) },
    pushedCount: pushed.length,
    leads: [...pushed, ...rest].map(({ ownerId, ...lead }) => lead),
  };
}

module.exports = { getQueue, getListLeads, getOwnedLeads, ownQueue, readList };
