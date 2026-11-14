jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn() }, lsqUrl: p => p }));
jest.mock('../services/rules', () => ({ istNow: () => ({ midnightIso: '2026-11-14T00:00:00+05:30' }) })); // = 2026-11-13 18:30 UTC
const { lsqClient } = require('../config/lsq');
const { viewRows, listViews, _cache } = require('../services/views');

const NOW = new Date('2026-11-14T10:00:00Z');
const base = { mx_Lead_Disposition: '', mx_Total_Calls: '3', mx_Total_Connects: '1', Source: 'Unknown', CreatedOn: '2026-10-01 10:00:00' };
let owned = [];
let facts = {}; // 'event:value' -> lead ids
let tasks = { 0: [], 1: [] };
const searches = [];

let leadTasks = {}; // lead id -> tasks someone else owns
lsqClient.get = jest.fn(async url => ({ data: { RecordCount: (leadTasks[url.match(/leadId=([^&]+)/)[1]] || []).length } }));
lsqClient.post.mockImplementation(async (url, body) => {
  if (url.includes('Leads.Get')) return { data: body.Paging.PageIndex === 1 ? owned : [] };
  if (url.includes('Task.svc/Retrieve')) return { data: { List: body.Paging.Offset ? [] : tasks[body.Parameter.StatusCode] } };
  if (url.includes('Activity/Retrieve/BySearchParameter')) {
    const rows = JSON.parse(body.AdvancedSearch).Conditions[0].RowCondition;
    const key = rows.length === 3 ? `${body.ActivityEvent}:${rows[1].LSO}=${rows[1].RSO}` : `${body.ActivityEvent}:${rows.at(-1).RSO}`;
    searches.push(key);
    const ids = facts[key] || [];
    return { data: { RecordCount: ids.length, List: ids.map(RelatedProspectId => ({ RelatedProspectId })) } };
  }
  throw new Error(`unexpected ${url}`);
});

const ids = async (view, who = 'L1') => (await viewRows({ lsq_user_id: who }, view, { columns: 'ProspectID', now: NOW })).map(r => r.ProspectID);
beforeEach(() => { _cache.clear(); owned = []; facts = {}; tasks = { 0: [], 1: [] }; leadTasks = {}; searches.length = 0; });

test('the 8 tabs, in the Smart Views order', () => {
  expect(listViews().map(v => v.name)).toEqual(['Leads assigned today', 'Pending follow up for today', 'Lead with zero connect',
    'Demo conducted not registered', 'Overdue task all time', 'Hot Lead - Outreach + Organic', 'Leads without Task', 'Open lead to be called']);
});

test('Leads assigned today: owner assigned today, a date LSQ keeps in IST', async () => {
  owned = [
    { ...base, ProspectID: 'today', mx_Owner_Assigned_Date_and_Time: '2026-11-14 11:46:00.000' },
    { ...base, ProspectID: 'yesterday', mx_Owner_Assigned_Date_and_Time: '2026-11-13 18:52:00.000' },
    { ...base, ProspectID: 'never' },
  ];
  expect(await ids('assigned-today')).toEqual(['today']);
});

test('Lead with zero connect: open, 0 connects, at most 25 calls, not called today', async () => {
  owned = [
    { ...base, ProspectID: 'yes', mx_Total_Connects: '0', mx_Total_Calls: '25' },
    { ...base, ProspectID: 'connected', mx_Total_Connects: '1' },
    { ...base, ProspectID: 'too-many', mx_Total_Connects: '0', mx_Total_Calls: '26' },
    { ...base, ProspectID: 'closed', mx_Total_Connects: '0', mx_Lead_Disposition: 'Not Interested' },
    { ...base, ProspectID: 'called', mx_Total_Connects: '0' },
  ];
  facts['22:opt-today'] = ['called'];
  expect(await ids('zero-connect')).toEqual(['yes']);
});

test('Open lead to be called: 286 counts like 218, payment completed and Hindi Medium leave', async () => {
  owned = ['ok', 'demo218', 'demo286', 'hindi286', 'paid', 'many'].map(ProspectID => ({ ...base, ProspectID }));
  owned.at(-1).mx_Total_Calls = '21';
  facts['218:mx_Custom_1=Demo Conducted'] = ['demo218'];
  facts['286:mx_Custom_1=Demo Conducted'] = ['demo286'];
  facts['286:mx_Custom_2=Hindi Medium'] = ['hindi286'];
  facts['266:mx_Custom_3=Completed'] = ['paid'];
  expect(await ids('open-to-call')).toEqual(['ok']);
});

test('Hot Lead: listed source, created after 17 Aug, not Hostelier', async () => {
  owned = [
    { ...base, ProspectID: 'hot', Source: 'insta', CreatedOn: '2026-09-01 10:00:00' },
    { ...base, ProspectID: 'old', Source: 'insta', CreatedOn: '2026-08-17 12:00:00' },
    { ...base, ProspectID: 'other-source', Source: 'Facebook', CreatedOn: '2026-09-01 10:00:00' },
    { ...base, ProspectID: 'hostel', Source: 'insta', CreatedOn: '2026-09-01 10:00:00' },
  ];
  facts['218:mx_Custom_3=Hostelier'] = ['hostel'];
  expect(await ids('hot-lead')).toEqual(['hot']);
});

test('Demo conducted not registered: a demo, no payment, not "not interested", not Applied', async () => {
  owned = ['demo', 'paid', 'notint', 'applied', 'nodemo'].map(ProspectID => ({ ...base, ProspectID }));
  owned[3].mx_Lead_Disposition = 'Applied';
  facts['218:mx_Custom_1=Demo Conducted'] = ['demo', 'paid', 'notint', 'applied'];
  facts['266:mx_Custom_3=Completed'] = ['paid'];
  facts['286:mx_Custom_13=Not interested'] = ['notint'];
  expect(await ids('demo-not-registered')).toEqual(['demo']);
});

test('task tabs: still due today, overdue (including earlier today), and leads with no task at all', async () => {
  owned = ['today', 'late', 'later', 'done', 'none', 'this-morning', 'old-owner'].map(ProspectID => ({ ...base, ProspectID }));
  leadTasks['old-owner'] = [{ OwnerName: 'previous owner', Status: 'Completed' }];
  tasks[0] = [
    { RelatedEntityId: 'today', DueDate: '2026-11-14 12:00:00.000' },
    { RelatedEntityId: 'this-morning', DueDate: '2026-11-14 04:00:00.000' },
    { RelatedEntityId: 'late', DueDate: '2026-11-10 12:00:00.000' },
    { RelatedEntityId: 'later', DueDate: '2026-12-01 12:00:00.000' },
  ];
  tasks[1] = [{ RelatedEntityId: 'done', DueDate: '2026-01-01 00:00:00.000' }];
  expect(await ids('follow-up-today')).toEqual(['today']);
  expect(await ids('overdue-tasks')).toEqual(['late', 'this-morning']);
  expect(await ids('no-task')).toEqual(['none']);
});

test('org-wide facts are read once and shared by everyone', async () => {
  owned = [{ ...base, ProspectID: 'x' }];
  await ids('open-to-call', 'L1');
  const reads = searches.length;
  await ids('hot-lead', 'L2');
  expect(searches.length).toBe(reads);
});

test('an unknown view gives null', async () => {
  expect(await viewRows({ lsq_user_id: 'L1' }, 'lv2', { now: NOW })).toBeNull();
});
