const supabase = require('../config/supabase');
const { lsqClient, lsqUrl } = require('../config/lsq');
const { activeRuleFor, istNow } = require('./rules');
const { fetchPushes, pendingPushes } = require('./pushed');
const { activityEventFor } = require('./activity');
const views = require('./views');

const LIST_CACHE_MS = 5 * 60 * 1000;
const PUSH_CACHE_MS = 60 * 1000; // a TL's push reaches the queue within a minute
const PAGE_SIZE = 200;
// Shown on the call screen when filled (picked from HR leads, 2026-11-04; LSQ lead fields are org-wide).
const DETAIL_COLUMNS = 'Source,SourceMedium,mx_District,mx_State,mx_Total_Calls,mx_Total_Connects,mx_Last_Spoken_On,LeadAge';
const COLUMNS = `ProspectID,FirstName,LastName,Phone,Mobile,ProspectStage,OwnerId,mx_Last_Attempted_On,${DETAIL_COLUMNS}`;
// Converted or ruled-out leads: never in the default queue. A TL rule can still target them on purpose.
const SKIP_BY_DEFAULT = new Set(['Signup Done', 'Payment Done', 'Customer', 'Disqualified']);
// HR keeps every candidate in one stage ("HR New Lead") and records outcomes in HR Activity, so its default
// queue is the candidates nobody has spoken to yet (Donald, 2026-11-04). Unanswered ones return on later days.
const HR_EVENT = 284;
// Only real Team HR members: anyone else in HR mode (Donald testing, the HR manager) keeps their own queue.
const keepByDefault = profile => {
  const hr = activityEventFor(profile) === HR_EVENT && (profile.groups || []).includes('Team HR');
  return l => !SKIP_BY_DEFAULT.has(l.stage) && !(hr && l.connects);
};
// One HR associate owns ~7,700 leads; reading them all takes over a minute and trips LSQ's rate limit.
// So the default queue stops at the newest MAX_QUEUE dialable leads (2 days of ~150 dials).
// shortcut: and reads at most MAX_PAGES pages (2,000 newest leads); older open leads need a TL push or rule.
const MAX_QUEUE = 300;
const MAX_PAGES = 10;

// shortcut: per-process cache, fine with one backend instance; move to a shared store if it's scaled out.
const _cache = new Map(); // 'list:<id>' | 'owner:<lsqUserId>' | 'pushes' | 'pushed-leads' -> { leads, expires } or { pending }

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
    // For the list row: when it was last dialed (UTC ISO, or null), how many calls, how many picked up.
    lastCall: p.mx_Last_Attempted_On ? `${String(p.mx_Last_Attempted_On).slice(0, 19).replace(' ', 'T')}Z` : null,
    calls: Number(p.mx_Total_Calls) || 0,
    details: details(p),
  };
};

// Every lead in a dynamic List. Page 1 asks LSQ to recalculate the List; later pages reuse that result.
async function readList(listId, { sortOn = 'CreatedOn', maxPages = Infinity } = {}) {
  const url = lsqUrl('LeadManagement.svc/Leads/Retrieve/BySearchParameter');
  const leads = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await lsqClient.post(url, {
      SearchParameters: { ListId: listId, RetrieveBehaviour: page === 1 ? '1' : '0' },
      Columns: { Include_CSV: COLUMNS },
      Sorting: { ColumnName: sortOn, Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data.Leads || [];
    leads.push(...rows.map(toLead));
    if (rows.length < PAGE_SIZE || leads.length >= data.RecordCount) break;
  }
  return leads;
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

// Leads by id in batches, for pushes: a pushed lead may be far older than the default queue reaches.
// One call per lead hit LSQ's 15-calls-in-5-seconds limit at 60+ pushes (2026-11-04).
async function readLeadsByIds(ids) {
  const leads = [];
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads/Retrieve/ByIds'), {
      SearchParameters: { LeadIds: ids.slice(i, i + PAGE_SIZE) },
      Columns: { Include_CSV: COLUMNS },
      Paging: { PageIndex: 1, PageSize: PAGE_SIZE },
    });
    leads.push(...(data.Leads || []).map(toLead));
  }
  return leads;
}

// Leads with this phone number (10 digits), for an incoming call. A number rings for several seconds and may call again,
// so the answer is kept 10 minutes.
const leadsByPhone = digits => cached(`phone:${digits}`, async () => {
  const { data } = await lsqClient.get(`${lsqUrl('LeadManagement.svc/RetrieveLeadByPhoneNumber')}&phone=${encodeURIComponent(digits)}`);
  return (Array.isArray(data) ? data : []).map(toLead);
}, 10 * 60 * 1000);

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
// Every pushed lead (all owners), read together and shared by everyone for a minute.
const getPushedLeadRows = () => cached('pushed-leads', async () => {
  const ids = [...new Set((await getPushes()).map(p => p.prospectId))];
  return ids.length ? readLeadsByIds(ids) : [];
}, PUSH_CACHE_MS);

// The caller's own leads with a phone number, minus the ones already dialed.
function ownQueue(leads, ownerId, dialedIds) {
  return leads.filter(l => l.ownerId === ownerId && l.phone && !dialedIds.has(l.prospectId));
}

// Leads a TL pushed (Auto Dialer activity) to this associate's leads, not dialed since the push.
async function getPushedLeads(profile) {
  const [all, rows] = await Promise.all([getPushes(), getPushedLeadRows()]);
  const leads = rows.filter(l => l.ownerId === profile.lsq_user_id && l.phone);
  const mine = new Set(leads.map(l => l.prospectId));
  const pushes = all.filter(p => mine.has(p.prospectId));
  if (!pushes.length) return [];
  const oldest = pushes.reduce((m, p) => (p.pushedAt < m ? p.pushedAt : m), pushes[0].pushedAt);
  const { data: attempts, error } = await supabase.from('dial_attempts').select('prospect_id, started_at')
    .eq('user_id', profile.id).in('prospect_id', [...new Set(pushes.map(p => p.prospectId))]).gte('started_at', oldest);
  if (error) throw error;
  return pendingPushes(pushes, leads, attempts);
}

// Today's attempts, split: `done` = leads called today (left out); `skippedAt` = leads only skipped today, with the
// time of the latest skip (they come back at the end of the queue).
function splitAttempts(attempts) {
  const done = new Set();
  const skippedAt = new Map();
  for (const a of attempts) {
    if (a.outcome !== 'skipped') done.add(a.prospect_id);
    else if (!(skippedAt.get(a.prospect_id) >= a.started_at)) skippedAt.set(a.prospect_id, a.started_at);
  }
  for (const id of done) skippedAt.delete(id);
  return { done, skippedAt };
}

// LSQ follow-ups (open tasks) due today whose time has passed and that this person hasn't dialed since: [{ prospectId, dueAt }],
// the earliest due first, once per lead. Yesterday's are left to the "Overdue task" tab.
function dueFollowUps(tasks, attempts, now = new Date()) {
  const midnight = new Date(istNow(now).midnightIso).getTime();
  const lastDial = new Map();
  for (const a of attempts) if (!(lastDial.get(a.prospect_id) >= a.started_at)) lastDial.set(a.prospect_id, a.started_at);
  const due = new Map();
  for (const t of tasks) {
    const at = new Date(`${String(t.DueDate).slice(0, 19).replace(' ', 'T')}Z`).getTime();
    if (!(at >= midnight && at <= now.getTime())) continue;
    const dialed = lastDial.get(t.RelatedEntityId);
    if (dialed && new Date(dialed).getTime() >= at) continue;
    if (!due.has(t.RelatedEntityId) || at < due.get(t.RelatedEntityId)) due.set(t.RelatedEntityId, at);
  }
  return [...due].sort((a, b) => a[1] - b[1]).map(([prospectId, at]) => ({ prospectId, dueAt: new Date(at).toISOString() }));
}

// Today's follow-ups still to come: [{ prospectId, name, dueAt }], the earliest first, once per lead. Only a heads-up
// on the list; each moves to the front when its time comes (dueFollowUps).
function upcomingFollowUps(tasks, now = new Date()) {
  const nextMidnight = new Date(istNow(now).midnightIso).getTime() + 24 * 60 * 60 * 1000;
  const soon = new Map();
  for (const t of tasks) {
    const at = new Date(`${String(t.DueDate).slice(0, 19).replace(' ', 'T')}Z`).getTime();
    if (!(at > now.getTime() && at < nextMidnight)) continue;
    if (!soon.has(t.RelatedEntityId) || at < soon.get(t.RelatedEntityId).at) soon.set(t.RelatedEntityId, { at, name: t.RelatedEntityIdName || '' });
  }
  return [...soon].sort((a, b) => a[1].at - b[1].at)
    .map(([prospectId, { at, name }]) => ({ prospectId, name, dueAt: new Date(at).toISOString() }));
}

/**
 * Leads a TL pushed come first. Then, by default, the newest leads the caller owns in LSQ (minus closed
 * stages; for HR, minus anyone already spoken to); a TL rule active right now replaces that part with its List.
 * Due LSQ follow-ups come right after pushes (not during a rule). Leads called today are left out; leads only skipped
 * today come back at the end.
 * `fresh` skips the LSQ caches for this caller.
 */
async function getQueue(profile, now = new Date(), { fresh = false, view = null } = {}) {
  const rule = await activeRuleFor(profile, now);
  // A Smart View tab the person picked (sales only); a running TL rule still wins. An unknown id falls back to their own leads.
  const viewInfo = !rule && view && profile.mode === 'sales' ? views.listViews().find(v => v.id === view) || null : null;
  // "Refresh leads" in the app: re-read LSQ now instead of waiting out the caches (new pushes, newly assigned leads).
  if (fresh) {
    ['pushes', 'pushed-leads', `owner:${profile.lsq_user_id}`, rule && `list:${rule.list_id}`].forEach(k => k && _cache.delete(k));
  }

  let dialedToday = supabase.from('dial_attempts').select('prospect_id, outcome, started_at')
    .eq('user_id', profile.id).gte('started_at', istNow(now).midnightIso);
  dialedToday = rule ? dialedToday.eq('rule_id', rule.id) : dialedToday.is('rule_id', null);

  const [leads, { data: dialed, error }, pushed, tasks] = await Promise.all([
    rule ? getListLeads(rule.list_id)
      : viewInfo ? views.viewRows(profile, viewInfo.id, { columns: COLUMNS, fresh, now }).then(rows => rows.map(toLead))
        : getOwnedLeads(profile),
    dialedToday,
    // Pushes are extra: if LSQ refuses that part, the caller still gets their normal queue.
    getPushedLeads(profile).catch(err => {
      console.error('[queue] pushes skipped:', err.response?.data?.ExceptionMessage || err.message);
      return [];
    }),
    // Due follow-ups are extra too, and never during a TL's rule.
    rule ? [] : views.openTasks(profile.lsq_user_id).catch(err => {
      console.error('[queue] follow-ups skipped:', err.response?.data?.ExceptionMessage || err.message);
      return [];
    }),
  ]);
  if (error) throw error;

  const pushedIds = new Set(pushed.map(l => l.prospectId));
  const { done, skippedAt } = splitAttempts(dialed);

  // Due follow-ups, after pushes: from the loaded leads when there, else read by id. Only the person's own, with a phone.
  const due = dueFollowUps(tasks, dialed, now).filter(f => !pushedIds.has(f.prospectId));
  const soon = upcomingFollowUps(tasks, now);
  const byId = new Map(leads.map(l => [l.prospectId, l]));
  const missing = [...new Set([...due, ...soon].map(f => f.prospectId))].filter(id => !byId.has(id));
  // Each read by id is kept 2 minutes: queue loads come every lead and every 30 s, and lead reads are LSQ's scarcest.
  const read = await Promise.all(missing.map(id => cached(`lead:${id}`, () => readLeadsByIds([id]), PUSH_CACHE_MS).catch(() => [])));
  read.flat().forEach(l => byId.set(l.prospectId, l));
  // A follow-up still counts on a lead already spoken to (HR's default leaves those out), but never on a closed stage.
  const followUps = due.map(f => byId.get(f.prospectId) && { ...byId.get(f.prospectId), followUp: { dueAt: f.dueAt } })
    .filter(l => l && l.ownerId === profile.lsq_user_id && l.phone && !SKIP_BY_DEFAULT.has(l.stage));
  const followIds = new Set(followUps.map(l => l.prospectId));
  // Today's follow-ups still to come, as leads, for the list (a lead called earlier today isn't in the queue until then).
  const upcoming = soon.map(f => byId.get(f.prospectId) && { ...byId.get(f.prospectId), dueAt: f.dueAt })
    .filter(l => l && l.ownerId === profile.lsq_user_id && l.phone && !SKIP_BY_DEFAULT.has(l.stage));

  const mine = ownQueue(leads, profile.lsq_user_id, done).filter(l => !pushedIds.has(l.prospectId) && !followIds.has(l.prospectId));
  // Skipped today: after everything else, the earliest skip first.
  const rest = [...mine.filter(l => !skippedAt.has(l.prospectId)),
    ...mine.filter(l => skippedAt.has(l.prospectId)).sort((a, b) => (skippedAt.get(a.prospectId) < skippedAt.get(b.prospectId) ? -1 : 1))];

  return {
    source: rule ? 'rule' : viewInfo ? 'view' : 'own',
    view: viewInfo,
    rule: rule && { id: rule.id, listName: rule.list_name, startTime: String(rule.start_time).slice(0, 5) },
    pushedCount: pushed.length,
    upcoming: upcoming.map(({ ownerId, connects, ...lead }) => ({ ...lead, picked: connects })),
    leads: [...pushed, ...followUps, ...rest].map(({ ownerId, connects, ...lead }) => ({ ...lead, picked: connects })),
  };
}

// How many leads each view would give right now (own leads with a phone, not called today; skipped ones count): the counts on the app's chips.
async function viewCounts(profile, now = new Date()) {
  const { data: dialed, error } = await supabase.from('dial_attempts').select('prospect_id, outcome, started_at')
    .eq('user_id', profile.id).gte('started_at', istNow(now).midnightIso).is('rule_id', null);
  if (error) throw error;
  const { done } = splitAttempts(dialed);
  const count = leads => ownQueue(leads, profile.lsq_user_id, done).length;
  const counts = await Promise.all([
    getOwnedLeads(profile).then(leads => ['own', count(leads)]),
    ...views.listViews().map(v => views.viewRows(profile, v.id, { columns: COLUMNS, now }).then(rows => [v.id, count(rows.map(toLead))])),
  ]);
  return Object.fromEntries(counts);
}

module.exports = { details, istTime, readLeadsByIds, leadsByPhone, getQueue, viewCounts, splitAttempts, dueFollowUps, upcomingFollowUps, getListLeads, getOwnedLeads, ownQueue, readList };
