jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn(), get: jest.fn() }, lsqUrl: p => p, lsqParams: () => ({ host: 'https://lsq' }) }));
jest.mock('../services/views', () => ({
  listViews: () => [{ id: 'assigned-today', name: 'Leads assigned today' }, { id: 'open-to-call', name: 'Open lead to be called' }],
  viewRows: jest.fn(),
  openTasks: jest.fn(async () => []),
}));
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
const { getQueue, viewCounts, dueFollowUps, upcomingFollowUps } = require('../services/queue');

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
  expect(q.leads).toEqual([{ prospectId: 'p1', name: 'A', phone: '900', stage: 'New Lead', details: [], lastCall: null, calls: 0, picked: 0 }]);
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


describe("views: a Smart View tab, worked out from the person's own leads (services/views.js)", () => {
  const views = require('../services/views');
  const sales = (n) => ({ id: `u${n}`, lsq_user_id: `L${n}`, groups: [], mode: 'sales' });

  test("a sales person's view: its rows, still only their own leads with a phone", async () => {
    activeRuleFor.mockResolvedValue(null);
    views.viewRows.mockResolvedValue([{ ProspectID: 'v1', OwnerId: 'L20', Mobile: '1' }, { ProspectID: 'v2', OwnerId: 'L99', Mobile: '2' }]);
    const q = await getQueue(sales(20), new Date(), { view: 'open-to-call' });
    expect(q.source).toBe('view');
    expect(q.view).toEqual({ id: 'open-to-call', name: 'Open lead to be called' });
    expect(q.leads.map(l => l.prospectId)).toEqual(['v1']);
    expect(views.viewRows.mock.calls.at(-1)[1]).toBe('open-to-call');
  });

  test('an unknown view or an HR person falls back to their own leads; a running rule wins over a view', async () => {
    activeRuleFor.mockResolvedValue(null);
    expect((await getQueue(sales(21), new Date(), { view: 'lv2' })).source).toBe('own');
    expect((await getQueue({ ...sales(23), mode: 'hr' }, new Date(), { view: 'open-to-call' })).source).toBe('own');
    activeRuleFor.mockResolvedValue({ id: 'r9', list_id: 'list9', list_name: 'Dialer – Callback', start_time: '16:00:00' });
    expect((await getQueue(sales(22), new Date(), { view: 'assigned-today' })).source).toBe('rule');
  });

  test('chip counts: per view, own leads with a phone, minus those dialed today', async () => {
    owned = [{ ProspectID: 'o1', OwnerId: 'L40', Mobile: '1', ProspectStage: 'New Lead' }, { ProspectID: 'o2', OwnerId: 'L40', Mobile: '2', ProspectStage: 'New Lead' }];
    mockDialRows = [{ prospect_id: 'o2' }];
    views.viewRows.mockImplementation(async (p, id) => (id === 'open-to-call'
      ? [{ ProspectID: 'o1', OwnerId: 'L40', Mobile: '1' }, { ProspectID: 'o2', OwnerId: 'L40', Mobile: '2' }, { ProspectID: 'x', OwnerId: 'L40' }]
      : []));
    expect(await viewCounts(sales(40))).toEqual({ own: 1, 'assigned-today': 0, 'open-to-call': 1 });
  });
});

describe('skipped leads come back at the end', () => {
  const lead = (id, owner) => ({ ProspectID: id, FirstName: id, OwnerId: owner, Mobile: '9', ProspectStage: 'New Lead' });

  test('a lead skipped today comes back at the end, oldest skip first', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a', 'b', 'c', 'd'].map(id => lead(id, 'L50'));
    mockDialRows = [
      { prospect_id: 'b', outcome: 'skipped', started_at: '2026-11-03T05:00:00Z' },
      { prospect_id: 'a', outcome: 'skipped', started_at: '2026-11-03T04:00:00Z' },
    ];
    const q = await getQueue({ id: 'u50', lsq_user_id: 'L50', groups: [] });
    expect(q.leads.map(l => l.prospectId)).toEqual(['c', 'd', 'a', 'b']);
  });

  test('a lead skipped then called today stays out', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a', 'b'].map(id => lead(id, 'L51'));
    mockDialRows = [
      { prospect_id: 'b', outcome: 'skipped', started_at: '2026-11-03T04:00:00Z' },
      { prospect_id: 'b', outcome: 'no_answer', started_at: '2026-11-03T05:00:00Z' },
    ];
    const q = await getQueue({ id: 'u51', lsq_user_id: 'L51', groups: [] });
    expect(q.leads.map(l => l.prospectId)).toEqual(['a']);
  });

  test('chip counts include leads skipped today', async () => {
    owned = ['a', 'b', 'c'].map(id => lead(id, 'L52'));
    mockDialRows = [
      { prospect_id: 'a', outcome: 'skipped', started_at: '2026-11-03T04:00:00Z' },
      { prospect_id: 'b', outcome: 'no_answer', started_at: '2026-11-03T04:00:00Z' },
    ];
    require('../services/views').viewRows.mockResolvedValue([]);
    const counts = await viewCounts({ id: 'u52', lsq_user_id: 'L52', groups: [], mode: 'sales' });
    expect(counts.own).toBe(2);
  });
});

describe('due follow-ups come first', () => {
  const views = require('../services/views');
  const lead = (id, owner) => ({ ProspectID: id, FirstName: id, OwnerId: owner, Mobile: '9', ProspectStage: 'New Lead' });
  const NOW = new Date('2026-11-03T10:00:00Z'); // the mocked IST midnight is 2026-11-02T18:30Z
  afterEach(() => views.openTasks.mockResolvedValue([]));

  test('dueFollowUps: due today and past, not dialed since, oldest first, once per lead', () => {
    const tasks = [
      { RelatedEntityId: 'late', DueDate: '2026-11-03 09:00:00.000' },
      { RelatedEntityId: 'early', DueDate: '2026-11-03 04:00:00.000' },
      { RelatedEntityId: 'early', DueDate: '2026-11-03 06:00:00.000' },
      { RelatedEntityId: 'later-today', DueDate: '2026-11-03 11:00:00.000' },
      { RelatedEntityId: 'yesterday', DueDate: '2026-11-02 12:00:00.000' },
      { RelatedEntityId: 'called', DueDate: '2026-11-03 08:00:00.000' },
    ];
    const attempts = [{ prospect_id: 'called', outcome: 'skipped', started_at: '2026-11-03T09:30:00Z' }];
    expect(dueFollowUps(tasks, attempts, NOW)).toEqual([
      { prospectId: 'early', dueAt: '2026-11-03T04:00:00.000Z' },
      { prospectId: 'late', dueAt: '2026-11-03T09:00:00.000Z' },
    ]);
  });

  test('due follow-ups come right after pushes, once, with followUp', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a', 'b', 'c'].map(id => lead(id, 'L60'));
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'c', DueDate: '2026-11-03 09:00:00.000' }]);
    const q = await getQueue({ id: 'u60', lsq_user_id: 'L60', groups: [] }, NOW);
    expect(q.leads.map(l => l.prospectId)).toEqual(['c', 'a', 'b']);
    expect(q.leads[0].followUp).toEqual({ dueAt: '2026-11-03T09:00:00.000Z' });
    expect(q.leads[1].followUp).toBeUndefined();
  });

  test('a follow-up on a lead someone else owns is left out', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a'].map(id => lead(id, 'L61'));
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'many1', DueDate: '2026-11-03 09:00:00.000' }]); // owned by L8
    const q = await getQueue({ id: 'u61', lsq_user_id: 'L61', groups: [] }, NOW);
    expect(q.leads.map(l => l.prospectId)).toEqual(['a']);
  });

  test('a follow-up lead outside the loaded leads is read by id', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a'].map(id => lead(id, 'L3'));
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'pushed-new', DueDate: '2026-11-03 09:00:00.000' }]);
    pushes = [];
    const q = await getQueue({ id: 'u62', lsq_user_id: 'L3', groups: [] }, NOW, { fresh: true });
    expect(q.leads.map(l => l.prospectId)).toEqual(['pushed-new', 'a']);
  });

  test('no follow-ups while a TL rule runs', async () => {
    activeRuleFor.mockResolvedValue({ id: 'r7', list_id: 'list7', list_name: 'Dialer – X', start_time: '16:00:00' });
    listRows = [];
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'c', DueDate: '2026-11-03 09:00:00.000' }]);
    const q = await getQueue({ id: 'u63', lsq_user_id: 'L63', groups: [] }, NOW);
    expect(q.leads).toEqual([]);
  });

  test('if LSQ refuses the tasks, the queue still loads', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = ['a'].map(id => lead(id, 'L64'));
    views.openTasks.mockRejectedValue(new Error('429'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = await getQueue({ id: 'u64', lsq_user_id: 'L64', groups: [] }, NOW);
      expect(q.leads.map(l => l.prospectId)).toEqual(['a']);
    } finally { spy.mockRestore(); }
  });
});

describe('review fixes: follow-ups', () => {
  const views = require('../services/views');
  const NOW = new Date('2026-11-03T10:00:00Z');
  afterEach(() => views.openTasks.mockResolvedValue([]));

  test('a follow-up lead read by id is cached, not read on every queue load', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = [{ ProspectID: 'a', FirstName: 'a', OwnerId: 'L3', Mobile: '9', ProspectStage: 'New Lead' }];
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'pushed-new', DueDate: '2026-11-03 09:00:00.000' }]);
    pushes = [];
    await getQueue({ id: 'u70', lsq_user_id: 'L3', groups: [] }, NOW, { fresh: true });
    const reads = byIdsCalls;
    await getQueue({ id: 'u70', lsq_user_id: 'L3', groups: [] }, NOW);
    expect(byIdsCalls).toBe(reads);
  });

  test('a follow-up on a closed lead (Customer) does not jump the queue', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = [{ ProspectID: 'a', FirstName: 'a', OwnerId: 'L3', Mobile: '9', ProspectStage: 'New Lead' }];
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'pushed-closed', DueDate: '2026-11-03 09:00:00.000' }]);
    pushes = [];
    const q = await getQueue({ id: 'u71', lsq_user_id: 'L3', groups: [] }, NOW, { fresh: true });
    expect(q.leads.map(l => l.prospectId)).toEqual(['a']);
  });
});

describe('coming-up follow-ups (a heads-up, not a jump)', () => {
  const views = require('../services/views');
  const NOW = new Date('2026-11-03T10:00:00Z'); // 3:30 pm IST; IST midnight ends at 2026-11-03T18:30Z
  afterEach(() => views.openTasks.mockResolvedValue([]));

  test('upcomingFollowUps: later today only, earliest first, once per lead, with the name', () => {
    const tasks = [
      { RelatedEntityId: 'b', RelatedEntityIdName: 'Rahul K', DueDate: '2026-11-03 12:45:00.000' },
      { RelatedEntityId: 'a', RelatedEntityIdName: 'Amulya Gowda', DueDate: '2026-11-03 11:30:00.000' },
      { RelatedEntityId: 'a', RelatedEntityIdName: 'Amulya Gowda', DueDate: '2026-11-03 13:00:00.000' },
      { RelatedEntityId: 'past', RelatedEntityIdName: 'Past', DueDate: '2026-11-03 09:00:00.000' },
      { RelatedEntityId: 'tomorrow', RelatedEntityIdName: 'Tomorrow', DueDate: '2026-11-03 19:00:00.000' },
    ];
    expect(upcomingFollowUps(tasks, NOW)).toEqual([
      { prospectId: 'a', name: 'Amulya Gowda', dueAt: '2026-11-03T11:30:00.000Z' },
      { prospectId: 'b', name: 'Rahul K', dueAt: '2026-11-03T12:45:00.000Z' },
    ]);
  });

  test('the queue reply carries them; none during a TL rule', async () => {
    activeRuleFor.mockResolvedValue(null);
    owned = [];
    views.openTasks.mockResolvedValue([{ RelatedEntityId: 'a', RelatedEntityIdName: 'Amulya Gowda', DueDate: '2026-11-03 11:30:00.000' }]);
    owned = [{ ProspectID: 'a', FirstName: 'Amulya', LastName: 'Gowda', OwnerId: 'L80', Mobile: '9', ProspectStage: 'New Lead', mx_Total_Calls: '3', mx_Total_Connects: '1' }];
    mockDialRows = [{ prospect_id: 'a', outcome: 'connected', started_at: '2026-11-03T09:00:00Z' }]; // called earlier today
    const q = await getQueue({ id: 'u80', lsq_user_id: 'L80', groups: [] }, NOW);
    expect(q.leads).toEqual([]); // not in today's queue until it's due
    expect(q.upcoming).toEqual([expect.objectContaining({ prospectId: 'a', name: 'Amulya Gowda', calls: 3, picked: 1, dueAt: '2026-11-03T11:30:00.000Z' })]);
    activeRuleFor.mockResolvedValue({ id: 'r8', list_id: 'list8', list_name: 'Dialer – X', start_time: '16:00:00' });
    listRows = [];
    expect((await getQueue({ id: 'u81', lsq_user_id: 'L81', groups: [] }, NOW)).upcoming).toEqual([]);
  });
});
