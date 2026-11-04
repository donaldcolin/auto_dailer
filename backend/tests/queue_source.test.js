jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn(), get: jest.fn() }, lsqUrl: p => p }));
jest.mock('../services/rules', () => ({
  activeRuleFor: jest.fn(),
  istNow: () => ({ midnightIso: '2026-11-03T00:00:00+05:30' }),
}));
// Chainable stand-in for supabase.from('dial_attempts')…; records filters and returns `mockDialRows`.
const mockCalls = [];
let mockDialRows = [];
jest.mock('../config/supabase', () => {
  const chain = {
    select: () => chain,
    eq: (...a) => (mockCalls.push(['eq', ...a]), chain),
    gte: () => chain,
    in: () => chain,
    is: (...a) => (mockCalls.push(['is', ...a]), chain),
    then: (resolve) => resolve({ data: mockDialRows, error: null }),
  };
  return { from: () => chain };
});
const { lsqClient } = require('../config/lsq');
const { activeRuleFor } = require('../services/rules');
const { getQueue } = require('../services/queue');

// Each test uses its own LSQ user id, so the per-owner cache never leaks between tests.
// Pushes are cached for a minute across users, so they're set once for the whole file.
const PUSHES = [
  { Id: 'act1', RelatedProspectId: 'pushed-closed', CreatedOn: '2026-11-03 06:00:00' },
  { Id: 'act2', RelatedProspectId: 'pushed-new', CreatedOn: '2026-11-03 05:00:00' },
];
let owned = [];
let listRows = [];
let ownedPagesRead = 0;
lsqClient.post.mockImplementation(async (url, body) => {
  if (url.includes('RetrieveRecentlyModified')) return { data: { ProspectActivities: PUSHES } };
  if (url.includes('Leads.Get')) {
    ownedPagesRead++;
    const { PageIndex, PageSize } = body.Paging;
    return { data: owned.slice((PageIndex - 1) * PageSize, PageIndex * PageSize) };
  }
  return { data: { RecordCount: listRows.length, Leads: listRows } };
});
// Pushed leads are read one by one; both belong to L3 (old enough to be outside any default queue).
const PUSHED_LEADS = {
  'pushed-new': { ProspectID: 'pushed-new', FirstName: 'New', OwnerId: 'L3', Mobile: '2', ProspectStage: 'New Lead' },
  'pushed-closed': { ProspectID: 'pushed-closed', FirstName: 'Closed', OwnerId: 'L3', Mobile: '3', ProspectStage: 'Customer' },
};
lsqClient.get.mockImplementation(async (url) => {
  const id = decodeURIComponent(url.split('&id=')[1]);
  return { data: PUSHED_LEADS[id] ? [PUSHED_LEADS[id]] : [] };
});
beforeEach(() => { mockCalls.length = 0; mockDialRows = []; owned = []; listRows = []; ownedPagesRead = 0; });

test('no rule: every lead the caller owns, minus closed stages and ones dialed today', async () => {
  activeRuleFor.mockResolvedValue(null);
  mockDialRows = [{ prospect_id: 'dialed' }];
  owned = [
    { ProspectID: 'p1', FirstName: 'A', OwnerId: 'L1', Mobile: '900', ProspectStage: 'New Lead' },
    { ProspectID: 'dialed', FirstName: 'B', OwnerId: 'L1', Phone: '901' },
    { ProspectID: 'p3', FirstName: 'C', OwnerId: 'L1' }, // no phone
    { ProspectID: 'p4', OwnerId: 'L1', Mobile: '902', ProspectStage: 'Signup Done' },
    { ProspectID: 'p5', OwnerId: 'L1', Mobile: '903', ProspectStage: 'Payment Done' },
    { ProspectID: 'p6', OwnerId: 'L1', Mobile: '904', ProspectStage: 'Disqualified' },
    { ProspectID: 'p7', OwnerId: 'L1', Mobile: '905', ProspectStage: 'Customer' },
  ];

  const q = await getQueue({ id: 'u1', lsq_user_id: 'L1', groups: [] });
  expect(q.source).toBe('own');
  expect(q.rule).toBeNull();
  expect(q.pushedCount).toBe(0);
  expect(q.leads).toEqual([{ prospectId: 'p1', name: 'A', phone: '900', stage: 'New Lead', details: [] }]);
  expect(mockCalls).toContainEqual(['is', 'rule_id', null]);
});

test("active rule: the rule's List, still only the caller's own leads", async () => {
  activeRuleFor.mockResolvedValue({ id: 'r1', list_id: 'list9', list_name: 'Dialer – Callback', start_time: '16:00:00' });
  const lp = (id, owner, extra = []) => ({ LeadPropertyList: [{ Attribute: 'ProspectID', Value: id }, { Attribute: 'OwnerId', Value: owner }, { Attribute: 'Mobile', Value: '1' }, ...extra] });
  listRows = [lp('x1', 'L2'), lp('x2', 'L9'), lp('x3', 'L2', [{ Attribute: 'ProspectStage', Value: 'Disqualified' }])];

  const q = await getQueue({ id: 'u2', lsq_user_id: 'L2', groups: [] });
  expect(q.source).toBe('rule');
  expect(q.rule).toEqual({ id: 'r1', listName: 'Dialer – Callback', startTime: '16:00' });
  expect(q.leads.map(l => l.prospectId)).toEqual(['x1', 'x3']); // a rule may target closed stages on purpose
  expect(mockCalls).toContainEqual(['eq', 'rule_id', 'r1']);
});

test('pushed leads come first (oldest push first), closed stages included, no duplicates', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [{ ProspectID: 'plain', FirstName: 'Plain', OwnerId: 'L3', Mobile: '1', ProspectStage: 'New Lead' }];

  const q = await getQueue({ id: 'u3', lsq_user_id: 'L3', groups: [] });
  expect(q.pushedCount).toBe(2);
  expect(q.leads.map(l => l.prospectId)).toEqual(['pushed-new', 'pushed-closed', 'plain']);
  expect(q.leads[0]).toMatchObject({ pushed: true, pushedAt: '2026-11-03T05:00:00.000Z' });
  expect(q.leads[2].pushed).toBeUndefined();
});

test('fresh: re-reads LSQ instead of the cached leads', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [{ ProspectID: 'a', OwnerId: 'L4', Mobile: '1', ProspectStage: 'New Lead' }];
  expect((await getQueue({ id: 'u4', lsq_user_id: 'L4', groups: [] })).leads).toHaveLength(1);

  owned = [...owned, { ProspectID: 'b', OwnerId: 'L4', Mobile: '2', ProspectStage: 'New Lead' }]; // ops assigns one more
  expect((await getQueue({ id: 'u4', lsq_user_id: 'L4', groups: [] })).leads).toHaveLength(1); // cached
  expect((await getQueue({ id: 'u4', lsq_user_id: 'L4', groups: [] }, new Date(), { fresh: true })).leads).toHaveLength(2);
});

test('details: filled fields only, in plain words, LSQ UTC shown as IST', () => {
  const { details } = require('../services/queue');
  expect(details({
    Source: 'Naukri', SourceMedium: 'ARMT Hindi Kalvium Job Posting', SourceCampaign: 'Exp 0-1 year',
    mx_District: 'Delhi', mx_State: '', mx_Total_Calls: '3', mx_Total_Connects: '1',
    mx_Last_Spoken_On: '2026-10-31 10:52:56.000', LeadAge: '5',
  })).toEqual([
    { label: 'Source', value: 'Naukri, ARMT Hindi Kalvium Job Posting' },
    { label: 'Campaign', value: 'Exp 0-1 year' },
    { label: 'Location', value: 'Delhi' },
    { label: 'Calls', value: '3 made, 1 connected' },
    { label: 'Last spoke', value: expect.stringMatching(/31 Oct.*4:22/i) },
    { label: 'Lead age', value: '5 days' },
  ]);
  expect(details({ mx_Total_Calls: '0', LeadAge: '1' })).toEqual([{ label: 'Lead age', value: '1 day' }]);
});

test('HR: only candidates nobody has spoken to (Total Connects 0), whatever the stage', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [
    { ProspectID: 'fresh', OwnerId: 'L5', Mobile: '1', ProspectStage: 'HR New Lead', mx_Total_Connects: '0' },
    { ProspectID: 'blank', OwnerId: 'L5', Mobile: '2', ProspectStage: 'HR New Lead' },
    { ProspectID: 'spoken', OwnerId: 'L5', Mobile: '3', ProspectStage: 'HR New Lead', mx_Total_Connects: '2' },
  ];
  const q = await getQueue({ id: 'u5', email: 'x@kalvium.com', lsq_user_id: 'L5', groups: ['Team HR'] });
  expect(q.leads.map(l => l.prospectId)).toEqual(['fresh', 'blank']);
  expect(q.leads[0].connects).toBeUndefined(); // internal, not sent to the app
});

test('a big owner: stops at 300 dialable leads instead of reading every page', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = Array.from({ length: 1000 }, (_, i) => ({ ProspectID: `b${i}`, OwnerId: 'L6', Mobile: String(i), ProspectStage: 'New Lead' }));
  const q = await getQueue({ id: 'u6', lsq_user_id: 'L6', groups: [] });
  expect(q.leads).toHaveLength(300);
  expect(q.leads[0].prospectId).toBe('b0'); // newest first, as LSQ sorts them
  expect(ownedPagesRead).toBe(2);
});
