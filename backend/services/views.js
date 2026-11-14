const { lsqClient, lsqUrl } = require('../config/lsq');
const { istNow } = require('./rules');

/**
 * The sales Smart View tabs (made by Tejas N, read from LSQ 2026-11-14), worked out from each person's own leads.
 * LSQ has no Smart Views API, and Lists can't do it: they are org-wide (up to 378k leads) and sales keys can't read
 * an admin's List. So the rules live here. When a tab changes in LSQ, change it here too (see SMART_VIEWS.md).
 * Wherever a tab looks at BDA Activity (218), the dialer's own Auto Dailer - BDA activity (286) counts the same.
 */

const OPEN_EXCLUDED = new Set(['Not Interested', 'Future Lead', 'Disqualified', 'Non-eligible stream', 'Financial Constraint lead']);
const HOT_SOURCES = new Set(['Social Media', 'Inbound Phone call', 'WA Lead', 'Influencer', 'Unknown', 'YouTube Nakkalites',
  'YouTube Theneer', 'Instagram Karthick', 'YouTube Behindwoods', 'YouTube', 'websiteform', 'School', 'TheneerYT',
  'Instagram_Eng_Stories', 'Instagram_Tamil_Stories', 'quiztest', 'youtubeads', 'yt_shorts', 'insta', 'insta_bio', 'insta_dm',
  'School_Outreach', 'school outreach', 'KalviumYouTube', 'blogs', 'Blog', 'Counselling-Blog', 'ig', 'Insta Ad', 'YT',
  'yt-ads-google', 'yt/gdn/search', 'google-yt/gdn/search-ads', 'yt%2Fgdn%2Fsearch', 'YT_lead+', 'YT_lead', 'YT_Theneer',
  'YT_Akash', 'YT_Darshan', 'YT_EDUSmarty', 'YT_MahiMasters', 'YT_Aravindh', 'YT_lead +', 'Instagram']);
const HOT_CREATED_AFTER = '2026-08-17 18:30:00'; // "Created On after 17/08/2026", end of that day in IST, as UTC

const open = l => !OPEN_EXCLUDED.has(l.disposition);

// f: the facts below for this person. Order = LSQ's tab order.
const VIEWS = [
  // Owner Assigned Date and Time is stored in IST, unlike LSQ's own dates (seen 2026-11-14: 3 of 14 were yesterday evening IST).
  { id: 'assigned-today', name: 'Leads assigned today', needs: [], test: (l, f) => !!l.assignedOn && l.assignedOn >= f.todayIst },
  { id: 'follow-up-today', name: 'Pending follow up for today', needs: ['tasks'], test: (l, f) => f.tasks.dueToday.has(l.id) },
  { id: 'zero-connect', name: 'Lead with zero connect', needs: ['called'],
    test: (l, f) => open(l) && l.connects === 0 && l.calls <= 25 && !f.called.has(l.id) },
  { id: 'demo-not-registered', name: 'Demo conducted not registered', needs: ['bda'],
    test: (l, f) => f.bda.demo.has(l.id) && !f.bda.paid.has(l.id) && !f.bda.notInterested.has(l.id)
      && l.disposition !== 'Applied' && l.disposition !== 'Applied from different number' },
  { id: 'overdue-tasks', name: 'Overdue task all time', needs: ['tasks'], test: (l, f) => f.tasks.overdue.has(l.id) },
  { id: 'hot-lead', name: 'Hot Lead - Outreach + Organic', needs: ['called', 'bda'],
    test: (l, f) => HOT_SOURCES.has(l.source) && l.createdOn > HOT_CREATED_AFTER && open(l) && l.calls <= 20
      && !f.called.has(l.id) && !f.bda.hostelier.has(l.id) },
  { id: 'no-task', name: 'Leads without Task', needs: ['tasks', 'doneTasks', 'leadTasks'],
    test: (l, f) => open(l) && !f.tasks.any.has(l.id) && !f.doneTasks.has(l.id) && !f.leadTasks.has(l.id) },
  { id: 'open-to-call', name: 'Open lead to be called', needs: ['called', 'bda'],
    test: (l, f) => open(l) && l.calls <= 20 && !f.called.has(l.id)
      && !f.bda.hindi.has(l.id) && !f.bda.demo.has(l.id) && !f.bda.paid.has(l.id) },
];

// shortcut: per-process cache, like queue.js; fine with one backend instance.
// Once something has been read, an expired copy is still served at once while a fresh one loads behind it,
// so nobody waits on the slow reads (the org-wide BDA facts take ~10 s) after the first time.
const _cache = new Map(); // key -> { value, expires, pending }
function cached(key, ttl, load) {
  const hit = _cache.get(key) || {};
  if ('value' in hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (!hit.pending) {
    hit.pending = load()
      .then(value => { _cache.set(key, { value, expires: Date.now() + ttl }); return value; })
      .catch(err => {
        if ('value' in hit) { console.error(`[views] ${key} refresh failed:`, err.response?.data?.ExceptionMessage || err.message); delete hit.pending; return hit.value; }
        _cache.delete(key);
        throw err;
      });
    _cache.set(key, hit);
  }
  return 'value' in hit ? Promise.resolve(hit.value) : hit.pending;
}
const MIN = 60 * 1000;

// Lead ids with an activity matching LSQ advanced-search rows (the Smart Views' own condition format), up to 1,000 a page.
async function activityLeads(event, rows, time = 'opt-all-time') {
  const row = ([LSO, LSO_Type, RSO]) => ({ SubConOp: 'And', LSO, LSO_Type, Operator: 'eq', RSO });
  const search = JSON.stringify({ GrpConOp: 'And', QueryTimeZone: 'India Standard Time', Conditions: [{ Type: 'Activity', ConOp: 'and', RowCondition: [
    row(['ActivityEvent', 'PAEvent', String(event)]), ...rows.map(row), row(['ActivityTime', 'DateTime', time]),
  ] }] });
  const read = PageIndex => lsqClient.post(lsqUrl('ProspectActivity.svc/Activity/Retrieve/BySearchParameter'), {
    ActivityEvent: event, AdvancedSearch: search, Paging: { PageIndex, PageSize: 1000 },
    Sorting: { ColumnName: 'CreatedOn', Direction: 1 }, Columns: { Include_CSV: 'RelatedProspectId' },
  }).then(r => r.data);
  const first = await read(1);
  // The rest of the pages together; the LSQ limiter in config/lsq.js paces them.
  const more = Array.from({ length: Math.ceil((first.RecordCount || 0) / 1000) - 1 }, (_, i) => read(i + 2));
  return new Set([first, ...await Promise.all(more)].flatMap(d => (d.List || []).map(a => a.RelatedProspectId)));
}
const union = sets => new Set(sets.flatMap(s => [...s]));
const DD = 'SearchableDropdown';

// BDA facts for the whole org (about 45k activities, 2026-11-14): read together, shared by everyone, 15 minutes.
// Field numbers differ between 218 and 286 (same labels): Activity Type c1/c1, Student Grade c3/c2, How was the session c17/c13.
const getBda = () => cached('bda', 15 * MIN, async () => {
  const both = async (f218, f286, value) => union(await Promise.all([
    activityLeads(218, [[f218, DD, value]]), activityLeads(286, [[f286, DD, value]])]));
  const [demo, hostelier, hindi, notInterested, paid] = await Promise.all([
    both('mx_Custom_1', 'mx_Custom_1', 'Demo Conducted'),
    both('mx_Custom_3', 'mx_Custom_2', 'Hostelier'),
    both('mx_Custom_3', 'mx_Custom_2', 'Hindi Medium'),
    both('mx_Custom_17', 'mx_Custom_13', 'Not interested'),
    activityLeads(266, [['mx_Custom_3', DD, 'Completed']]),
  ]);
  return { demo, hostelier, hindi, notInterested, paid };
});

// Leads with an Outbound Phone Call (Callyzer, 22) today, for everyone: a few thousand a day, so 2 minutes.
const getCalledToday = () => cached('called-today', 2 * MIN, () => activityLeads(22, [], 'opt-today'));

// A person's tasks by lead, read by owner. Open tasks change often (2 minutes); completed ones, ~10k for a long-time counsellor, only
// matter to "Leads without Task" and are read every 30 minutes.
async function readTasks(lsqUserId, status, maxRows) {
  const list = [];
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const { data } = await lsqClient.post(lsqUrl('Task.svc/Retrieve'), {
      Parameter: { LookupName: 'OwnerId', LookupValue: lsqUserId, FromDate: '2010-01-01 00:00:00', ToDate: '2100-01-01 00:00:00', StatusCode: status },
      Sorting: { ColumnName: 'Duedate', Direction: '1' }, Paging: { Offset: offset, RowCount: 1000 },
    });
    const rows = data.List || [];
    list.push(...rows);
    if (rows.length < 1000) break;
  }
  return list.filter(t => t.RelatedEntityId);
}
const getTasks = (lsqUserId, now) => cached(`tasks:${lsqUserId}`, 2 * MIN, async () => {
  const rows = await readTasks(lsqUserId, 0, 5000);
  const at = t => String(t.DueDate).slice(0, 19); // UTC
  const nowUtc = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const { nextMidnight } = dayBounds(now);
  return {
    any: new Set(rows.map(t => t.RelatedEntityId)),
    // LSQ's "pending" is still to come: a task due earlier today is already "overdue" (matched LSQ for one user, 2026-11-14).
    dueToday: new Set(rows.filter(t => at(t) >= nowUtc && at(t) < nextMidnight).map(t => t.RelatedEntityId)),
    overdue: new Set(rows.filter(t => at(t) < nowUtc).map(t => t.RelatedEntityId)),
  };
});
// shortcut: reads at most 20,000 completed tasks; a counsellor with more may see a few leads in "Leads without Task" that have old tasks.
const getDoneTasks = lsqUserId => cached(`done-tasks:${lsqUserId}`, 30 * MIN, async () =>
  new Set((await readTasks(lsqUserId, 1, 20000)).map(t => t.RelatedEntityId)));

// Leads (of `ids`) with any task at all, whoever owns it: a previous owner's task counts in LSQ (2 of Vinay's 5 "without
// task" leads had one, 2026-11-14). One call per lead, so only for the few leads the owner's own tasks don't settle.
async function leadsWithAnyTask(ids) {
  const has = await Promise.all(ids.map(id => cached(`lead-tasks:${id}`, 30 * MIN, async () => {
    const { data } = await lsqClient.get(`${lsqUrl('LeadManagement.svc/RetrieveTaskByLeadId')}&leadId=${encodeURIComponent(id)}`);
    return (data.RecordCount || 0) > 0;
  })));
  return new Set(ids.filter((_, i) => has[i]));
}

// Today in IST as UTC "YYYY-MM-DD HH:mm:ss" bounds, LSQ's date format.
function dayBounds(now) {
  const lsq = d => d.toISOString().replace('T', ' ').slice(0, 19);
  const start = new Date(istNow(now).midnightIso);
  return { midnight: lsq(start), nextMidnight: lsq(new Date(start.getTime() + 24 * 60 * MIN)) };
}

const VIEW_COLUMNS = 'ProspectID,Source,mx_Lead_Disposition,mx_Total_Calls,mx_Total_Connects,mx_Owner_Assigned_Date_and_Time,CreatedOn,ModifiedOn';
const PAGE_SIZE = 200;
// shortcut: the newest-changed OWNED_PAGES pages (4,000 leads) per person; a counsellor owning more misses their oldest leads in views.
const OWNED_PAGES = 20;

// Every lead the person owns, newest change first (the Smart Views' order), with the fields the rules read. 2 minutes.
const getOwnedRows = (lsqUserId, columns) => cached(`owned:${lsqUserId}`, 2 * MIN, async () => {
  const rows = [];
  for (let page = 1; page <= OWNED_PAGES; page++) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads.Get'), {
      Parameter: { LookupName: 'OwnerId', LookupValue: lsqUserId, SqlType: 'uniqueidentifier' },
      Columns: { Include_CSV: `${columns},${VIEW_COLUMNS}` },
      Sorting: { ColumnName: 'ModifiedOn', Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) break;
  }
  return rows;
});

const asLead = r => ({
  id: r.ProspectID,
  disposition: r.mx_Lead_Disposition || '',
  calls: Number(r.mx_Total_Calls) || 0,
  connects: Number(r.mx_Total_Connects) || 0,
  source: r.Source || '',
  createdOn: String(r.CreatedOn || '').slice(0, 19),
  assignedOn: r.mx_Owner_Assigned_Date_and_Time ? String(r.mx_Owner_Assigned_Date_and_Time).slice(0, 19) : '',
});

/** The person's own lead rows (as LSQ returns them) in a view, in the Smart View's order. `columns`: what the queue shows. */
async function viewRows(profile, viewId, { columns, fresh = false, now = new Date() } = {}) {
  const view = VIEWS.find(v => v.id === viewId);
  if (!view) return null;
  const who = profile.lsq_user_id;
  if (fresh) [`owned:${who}`, `tasks:${who}`].forEach(k => _cache.delete(k));
  const need = new Set(view.needs);
  const [rows, called, bda, tasks, doneTasks] = await Promise.all([
    getOwnedRows(who, columns),
    need.has('called') ? getCalledToday() : null,
    need.has('bda') ? getBda() : null,
    need.has('tasks') ? getTasks(who, now) : null,
    need.has('doneTasks') ? getDoneTasks(who) : null,
  ]);
  const todayIst = new Date(now.getTime() + 330 * MIN).toISOString().slice(0, 10); // "YYYY-MM-DD"
  const facts = { called, bda, tasks, doneTasks, todayIst, leadTasks: new Set() };
  const found = rows.filter(r => view.test(asLead(r), facts));
  if (!need.has('leadTasks')) return found;
  facts.leadTasks = await leadsWithAnyTask(found.map(r => r.ProspectID));
  return found.filter(r => !facts.leadTasks.has(r.ProspectID));
}

const listViews = () => VIEWS.map(({ id, name }) => ({ id, name }));

// At startup, so the first person to open a view doesn't wait for the org-wide reads.
const warm = () => Promise.all([getBda(), getCalledToday()])
  .catch(err => console.error('[views] warm-up failed:', err.response?.data?.ExceptionMessage || err.message));

module.exports = { VIEWS, listViews, viewRows, asLead, warm, _cache };
