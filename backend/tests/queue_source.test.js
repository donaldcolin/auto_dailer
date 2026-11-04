jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn() }, lsqUrl: p => p }));
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
lsqClient.post.mockImplementation(async (url) => {
  if (url.includes('RetrieveRecentlyModified')) return { data: { ProspectActivities: PUSHES } };
  if (url.includes('Leads.Get')) return { data: owned };
  return { data: { RecordCount: listRows.length, Leads: listRows } };
});
beforeEach(() => { mockCalls.length = 0; mockDialRows = []; owned = []; listRows = []; });

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
  expect(q.leads).toEqual([{ prospectId: 'p1', name: 'A', phone: '900', stage: 'New Lead' }]);
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
  owned = [
    { ProspectID: 'plain', FirstName: 'Plain', OwnerId: 'L3', Mobile: '1', ProspectStage: 'New Lead' },
    { ProspectID: 'pushed-new', FirstName: 'New', OwnerId: 'L3', Mobile: '2', ProspectStage: 'New Lead' },
    { ProspectID: 'pushed-closed', FirstName: 'Closed', OwnerId: 'L3', Mobile: '3', ProspectStage: 'Customer' },
  ];

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
