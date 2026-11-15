const mockPost = jest.fn();
jest.mock('../config/lsq', () => ({ lsqClient: { post: (...a) => mockPost(...a), get: jest.fn() }, lsqUrl: p => p }));
jest.mock('../services/activity', () => ({
  FORMS: { 263: {} },
  getForm: async () => ({
    sections: [['Lead Qualification', ['mx_Custom_1', 'mx_Custom_3', 'mx_Custom_2', 'mx_Custom_9', 'mx_Custom_44', 'ActivityEvent_Note', 'mx_Custom_4']]],
    sticky: ['mx_Custom_2', 'mx_Custom_9'],
    connected: { schema: 'mx_Custom_1', reason: 'mx_Custom_3' },
    fields: [
      { schema: 'mx_Custom_2', label: 'Select Activity Type', type: 'dropdown' },
      { schema: 'mx_Custom_44', label: 'Screening Status', type: 'dropdown' },
      { schema: 'mx_Custom_4', label: 'Follow Up date', type: 'datetime' },
    ],
  }),
}));
const mockDials = { data: [] };
jest.mock('../config/supabase', () => {
  const q = { select: () => q, eq: () => q, order: () => q, limit: async () => mockDials };
  return { from: () => q };
});
const { leadHistory } = require('../services/history');

test('history: one line per call, the reason when it did not connect, time spoken when it did', async () => {
  mockPost.mockResolvedValue({ data: { ProspectActivities: [
    { EventCode: 283, EventName: 'Auto Dialer', CreatedOn: '2026-11-04 14:19:00', Data: [], ActivityFields: { mx_Custom_1: 'Yes' } },
    // Callyzer logged the connected call after it was marked: merged into the marked line.
    { EventCode: 22, EventName: 'Outbound Phone Call Activity', CreatedOn: '2026-10-29 08:16:00', Data: [{ Key: 'Duration', Value: '124' }] },
    { EventCode: 203, EventName: 'SMS Sent', CreatedOn: '2026-10-29 08:15:09', Data: [] },
    { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-10-29 08:14:46', Data: [],
      ActivityFields: { mx_Custom_1: 'Yes', mx_Custom_2: 'Screening Round', mx_Custom_44: 'JD Sent', mx_Custom_4: '2026-11-05 05:00:00', ActivityEvent_Note: 'call after 5' } },
    { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-10-28 06:00:00', Data: [],
      ActivityFields: { mx_Custom_1: 'No', mx_Custom_3: 'Busy in another call', mx_Custom_2: 'Screening Round' } },
    { EventCode: 22, EventName: 'Outbound Phone Call Activity', CreatedOn: '2026-10-28 05:59:00', Data: [{ Key: 'Duration', Value: '0' }] },
    { EventCode: 21, EventName: 'Inbound Phone Call Activity', CreatedOn: '2026-10-27 05:00:00', Data: [{ Key: 'Duration', Value: '40' }] },
    { EventCode: 3002, EventName: 'StageChange', CreatedOn: '2026-10-26 05:00:00', Data: [{ Key: 'PreviousStage', Value: 'New' }, { Key: 'CurrentStage', Value: 'Screening' }] },
  ] } });
  const h = await leadHistory('lead1', 6, Date.parse('2026-10-29T12:00:00Z'));
  expect(mockPost.mock.calls[0][0]).toContain('leadId=lead1');
  expect(h.map(x => [x.kind, x.what])).toEqual([
    ['spoke', 'HR Activity'], ['missed', 'HR Activity'], ['spoke', 'Incoming call'], ['other', 'Stage changed'],
  ]);
  expect(h[0]).toMatchObject({ note: 'call after 5', at: 'Today, 1:44 pm' });
  expect(h[0].detail).toMatch(/^Spoke 2m 4s · Screening Round · JD Sent · Follow up 5 Nov/);
  expect(h[1]).toMatchObject({ detail: 'Busy in another call', at: 'Yesterday, 11:30 am' });
  expect(h[2].detail).toBe('Spoke 40s');
  expect(h[3].detail).toBe('New → Screening');
});

test('talk time comes from the dialer\'s own record first, and a save posted twice shows once', async () => {
  const marked = { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-11-10 14:48:08', Data: [], ActivityFields: { mx_Custom_1: 'Yes', mx_Custom_2: 'Screening Round' } };
  mockPost.mockResolvedValue({ data: { ProspectActivities: [marked, { ...marked }] } });
  mockDials.data = [{ started_at: '2026-11-10T14:48:08.064+00:00', talk_seconds: 11 }];
  const h = await leadHistory('lead1');
  expect(h.map(x => x.detail)).toEqual(['Spoke 11s · Screening Round']);
  mockDials.data = [];
});

test("Notes-tab notes join the history in time order, with who wrote them", async () => {
  mockPost.mockImplementation(async (url, body) => (url.includes('RetrieveNote')
    ? { data: { RecordCount: 1, List: [{ Note: 'Test note By donald colin', CreatedByName: 'Donald Colin', CreatedOn: '2026-11-15 07:55:21' }] } }
    : { data: { ProspectActivities: [
      { EventCode: 21, EventName: 'Inbound Phone Call Activity', CreatedOn: '2026-11-15 07:57:20', Data: [{ Key: 'Duration', Value: '40' }] },
      { EventCode: 21, EventName: 'Inbound Phone Call Activity', CreatedOn: '2026-11-15 07:55:00', Data: [{ Key: 'Duration', Value: '10' }] },
    ] } }));
  const h = await leadHistory('lead9', 6, Date.parse('2026-11-15T10:00:00Z'));
  const call = mockPost.mock.calls.filter(c => c[0].includes('RetrieveNote')).at(-1);
  expect(call[1].Parameter).toEqual({ RelatedId: 'lead9' });
  expect(h.map(x => x.kind)).toEqual(['spoke', 'note', 'spoke']);
  expect(h[1]).toMatchObject({ kind: 'note', what: 'Note', detail: 'by Donald Colin', note: 'Test note By donald colin', at: 'Today, 1:25 pm' });
});

test('if LSQ refuses the notes, the activities still come back', async () => {
  mockPost.mockImplementation(async (url) => {
    if (url.includes('RetrieveNote')) throw new Error('429');
    return { data: { ProspectActivities: [{ EventCode: 21, EventName: 'Inbound', CreatedOn: '2026-11-15 07:57:20', Data: [{ Key: 'Duration', Value: '40' }] }] } };
  });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await leadHistory('lead10', 6, Date.parse('2026-11-15T10:00:00Z'))).map(x => x.kind)).toEqual(['spoke']);
  } finally { spy.mockRestore(); }
});

test('only the newest note is shown: older Notes-tab notes go, older activity notes lose their text', async () => {
  mockPost.mockImplementation(async (url) => (url.includes('RetrieveNote')
    ? { data: { List: [{ Note: 'older tab note', CreatedByName: 'Donald Colin', CreatedOn: '2026-11-15 07:55:21' }] } }
    : { data: { ProspectActivities: [
      { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-11-15 07:57:20', Data: [], ActivityFields: { mx_Custom_1: 'Yes', ActivityEvent_Note: 'newest' } },
      { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-11-15 07:55:00', Data: [], ActivityFields: { mx_Custom_1: 'Yes', ActivityEvent_Note: 'older activity note' } },
    ] } }));
  const h = await leadHistory('lead11', 6, Date.parse('2026-11-15T10:00:00Z'));
  expect(h.map(x => [x.kind, x.note])).toEqual([['spoke', 'newest'], ['spoke', '']]);
});
