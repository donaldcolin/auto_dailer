const mockPost = jest.fn();
jest.mock('../config/lsq', () => ({ lsqClient: { post: (...a) => mockPost(...a), get: jest.fn() }, lsqUrl: p => p }));
jest.mock('../services/activity', () => ({
  FORMS: { 263: {} },
  getForm: async () => ({
    short: ['mx_Custom_1', 'mx_Custom_3', 'mx_Custom_2', 'mx_Custom_9', 'mx_Custom_44', 'ActivityEvent_Note', 'mx_Custom_4'],
    sticky: ['mx_Custom_2', 'mx_Custom_9'],
    connected: { schema: 'mx_Custom_1', reason: 'mx_Custom_3' },
    fields: [
      { schema: 'mx_Custom_44', label: 'Screening Status', type: 'dropdown' },
      { schema: 'mx_Custom_4', label: 'Follow Up date', type: 'datetime' },
    ],
  }),
}));
const { leadHistory } = require('../services/history');

test('history: newest first, HR Activity values in words, calls and pushes renamed', async () => {
  mockPost.mockResolvedValue({ data: { ProspectActivities: [
    { EventCode: 283, EventName: 'Auto Dialer', CreatedOn: '2026-11-04 14:19:00', Data: [{ Key: 'CreatedByName', Value: 'Harshitha Rakesh' }], ActivityFields: { mx_Custom_1: 'Yes' } },
    { EventCode: 263, EventName: 'HR Activity', CreatedOn: '2026-10-29 08:14:46', Data: [{ Key: 'CreatedByName', Value: 'Harshitha Rakesh' }],
      ActivityFields: { mx_Custom_1: 'Yes', mx_Custom_2: 'Screening Round', mx_Custom_44: 'JD Sent', mx_Custom_4: '2026-11-05 05:00:00', ActivityEvent_Note: 'call after 5' } },
    { EventCode: 22, EventName: 'Outbound Phone Call Activity', CreatedOn: '2026-10-29 08:13:40', Data: [{ Key: 'CallType', Value: 'InComplete' }] },
  ] } });
  const h = await leadHistory('lead1');
  expect(mockPost.mock.calls[0][0]).toContain('leadId=lead1');
  expect(h[0]).toMatchObject({ what: 'Pushed to the dialer', by: 'Harshitha Rakesh', detail: '' });
  expect(h[1]).toMatchObject({ what: 'HR Activity', note: 'call after 5', at: expect.stringMatching(/29 Oct.*1:44/) });
  expect(h[1].detail).toMatch(/^Connected, Screening Status: JD Sent, Follow Up date: 5 Nov.*10:30/i); // sticky Activity Type left out
  expect(h[2]).toMatchObject({ what: 'Outgoing call', detail: 'InComplete' });
});
