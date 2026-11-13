jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn(), get: jest.fn() }, lsqUrl: p => p, lsqParams: () => ({ host: 'https://lsq' }) }));
const mockKeys = { value: { accessKey: 'ak', secretKey: 'sk' } };
jest.mock('../services/lsq_keys', () => ({ getKeys: async () => mockKeys.value, keyHeaders: k => ({ key: k.accessKey }) }));
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
let byIdsCalls = 0;
let pushes = PUSHES;
lsqClient.post.mockImplementation(async (url, body, opts) => {
  if (url.includes('RetrieveRecentlyModified')) return { data: { ProspectActivities: pushes } };
  if (url.includes('Retrieve/ByIds')) {
    byIdsCalls++;
    return { data: { Leads: body.SearchParameters.LeadIds.map(id => PUSHED_LEADS[id]).filter(Boolean) } };
  }
  if (url.includes('Leads.Get')) {
    ownedPagesRead++;
    const { PageIndex, PageSize } = body.Paging;
    return { data: owned.slice((PageIndex - 1) * PageSize, PageIndex * PageSize) };
  }
  listReads.push({ url, sort: body.Sorting.ColumnName, headers: opts?.headers });
  return { data: { RecordCount: listRows.length, Leads: listRows } };
});
const listReads = [];
lsqClient.get.mockImplementation(async url => (url.includes('Lists.Get')
  ? { data: [
    { ListId: 'lv2', ListName: 'Dialer – Open lead to be called', ListType: 'dynamic' },
    { ListId: 'lv1', ListName: 'Dialer – Leads assigned today', ListType: 'dynamic' },
  ] }
  : { data: [] }));
// Pushed leads are read one by one; both belong to L3 (old enough to be outside any default queue).
const PUSHED_LEADS = {
  ...Object.fromEntries(Array.from({ length: 67 }, (_, i) => [`many${i}`, { ProspectID: `many${i}`, FirstName: `M${i}`, OwnerId: 'L8', Mobile: String(i) }])),
  'pushed-new': { ProspectID: 'pushed-new', FirstName: 'New', OwnerId: 'L3', Mobile: '2', ProspectStage: 'New Lead' },
  'pushed-closed': { ProspectID: 'pushed-closed', FirstName: 'Closed', OwnerId: 'L3', Mobile: '3', ProspectStage: 'Customer' },
};

beforeEach(() => { mockCalls.length = 0; mockDialRows = []; owned = []; listRows = []; ownedPagesRead = 0; byIdsCalls = 0; pushes = PUSHES; });

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
    { label: 'Location', value: 'Delhi' },
    { label: 'Calls', value: '3 made, 1 connected' },
    { label: 'Last spoke', value: expect.stringMatching(/31 Oct.*4:22/i) },
    { label: 'Lead age', value: '5 days' },
  ]);
  expect(details({ mx_Total_Calls: '0', LeadAge: '1' })).toEqual([{ label: 'Lead age', value: '1 day' }]);
});

test('HR: only candidates nobody has spoken to (Total Connects 0), and never closed stages', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [
    { ProspectID: 'fresh', OwnerId: 'L5', Mobile: '1', ProspectStage: 'HR New Lead', mx_Total_Connects: '0' },
    { ProspectID: 'blank', OwnerId: 'L5', Mobile: '2', ProspectStage: 'HR New Lead' },
    { ProspectID: 'spoken', OwnerId: 'L5', Mobile: '3', ProspectStage: 'HR New Lead', mx_Total_Connects: '2' },
    { ProspectID: 'closed', OwnerId: 'L5', Mobile: '4', ProspectStage: 'Customer', mx_Total_Connects: '0' },
  ];
  const q = await getQueue({ id: 'u5', mode: 'hr', lsq_user_id: 'L5', groups: ['Team HR'] });
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

test('HR mode outside Team HR (Donald testing): own leads, not the never-connected rule', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [{ ProspectID: 'spoken', OwnerId: 'L7', Mobile: '1', ProspectStage: 'HR New Lead', mx_Total_Connects: '5' }];
  const q = await getQueue({ id: 'u7', mode: 'hr', lsq_user_id: 'L7', groups: [] });
  expect(q.leads.map(l => l.prospectId)).toEqual(['spoken']);
});

test('67 pushed leads are read in one LSQ call (one call each hit the rate limit)', async () => {
  activeRuleFor.mockResolvedValue(null);
  pushes = Array.from({ length: 67 }, (_, i) => ({ Id: `a${i}`, RelatedProspectId: `many${i}`, CreatedOn: '2026-11-04 14:00:00' }));
  const q = await getQueue({ id: 'u8', lsq_user_id: 'L8', groups: [] }, new Date(), { fresh: true });
  expect(q.pushedCount).toBe(67);
  expect(byIdsCalls).toBe(1);
});

test('if LSQ refuses the pushed leads, the normal queue still loads', async () => {
  activeRuleFor.mockResolvedValue(null);
  owned = [{ ProspectID: 'own1', OwnerId: 'L9', Mobile: '1', ProspectStage: 'New Lead' }];
  const real = lsqClient.post.getMockImplementation();
  lsqClient.post.mockImplementation(async (url, body, opts) => {
    if (url.includes('Retrieve/ByIds')) throw Object.assign(new Error('429'), { response: { data: { ExceptionMessage: 'API calls exceeded the limit' } } });
    return real(url, body);
  });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const q = await getQueue({ id: 'u9', lsq_user_id: 'L9', groups: [] }, new Date(), { fresh: true });
    expect(q.leads.map(l => l.prospectId)).toEqual(['own1']);
    expect(q.pushedCount).toBe(0);
  } finally {
    lsqClient.post.mockImplementation(real);
    spy.mockRestore();
  }
});


describe('views: a Smart View tab mirrored by a "Dialer – …" List', () => {
  const lp = (id, owner) => ({ LeadPropertyList: [{ Attribute: 'ProspectID', Value: id }, { Attribute: 'OwnerId', Value: owner }, { Attribute: 'Mobile', Value: '1' }] });
  beforeEach(() => { listReads.length = 0; mockKeys.value = { accessKey: 'ak', secretKey: 'sk' }; });

  test('views come in the Smart Views order, prefix removed', async () => {
    const { getViews } = require('../services/queue');
    expect(await getViews()).toEqual([{ id: 'lv1', name: 'Leads assigned today' }, { id: 'lv2', name: 'Open lead to be called' }]);
  });

  test("the List is read with the person's own key, newest change first, and still only their leads", async () => {
    activeRuleFor.mockResolvedValue(null);
    listRows = [lp('v1', 'L20'), lp('v2', 'L99')];
    const q = await getQueue({ id: 'u20', lsq_user_id: 'L20', groups: [] }, new Date(), { view: 'lv2' });
    expect(q.source).toBe('view');
    expect(q.view).toEqual({ id: 'lv2', name: 'Open lead to be called' });
    expect(q.leads.map(l => l.prospectId)).toEqual(['v1']);
    expect(listReads[0]).toMatchObject({ url: 'https://lsq/LeadManagement.svc/Leads/Retrieve/BySearchParameter', sort: 'ModifiedOn', headers: { key: 'ak' } });
  });

  test('an unknown view falls back to their own leads; a running rule wins over a view', async () => {
    activeRuleFor.mockResolvedValue(null);
    expect((await getQueue({ id: 'u21', lsq_user_id: 'L21', groups: [] }, new Date(), { view: 'gone' })).source).toBe('own');
    activeRuleFor.mockResolvedValue({ id: 'r9', list_id: 'list9', list_name: 'Dialer – Callback', start_time: '16:00:00' });
    expect((await getQueue({ id: 'u22', lsq_user_id: 'L22', groups: [] }, new Date(), { view: 'lv1' })).source).toBe('rule');
  });

  test('no personal key: asked to add it, never read with the admin key', async () => {
    activeRuleFor.mockResolvedValue(null);
    mockKeys.value = null;
    await expect(getQueue({ id: 'u23', lsq_user_id: 'L23', groups: [] }, new Date(), { view: 'lv1' })).rejects.toMatchObject({ status: 422 });
    expect(listReads).toHaveLength(0);
  });
});
