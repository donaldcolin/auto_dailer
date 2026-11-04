// No test may reach the real LSQ.
jest.mock('../config/lsq', () => ({ lsqClient: { get: jest.fn(), post: jest.fn() }, lsqUrl: p => p }));
const inserted = [];
jest.mock('../config/supabase', () => ({
  auth: { getUser: jest.fn() },
  from: () => ({ insert: async row => (inserted.push(row), { error: null }) }),
}));
jest.mock('../services/profile', () => ({ getProfile: jest.fn() }));
jest.mock('../services/lsq_lists', () => ({ getDialerLists: jest.fn() }));
jest.mock('../services/team', () => ({ withTeamLead: async p => ({ ...p, tlGroups: [] }) }));
const request = require('supertest');
const supabase = require('../config/supabase');
const { getProfile } = require('../services/profile');
const { getDialerLists } = require('../services/lsq_lists');
const app = require('../server');
const { clearAuthCache } = require('../middleware/auth');

// Each test uses a different token so the auth middleware's token cache doesn't leak between tests.
const as = (access) => {
  clearAuthCache();
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@kalvium.com' } }, error: null });
  getProfile.mockResolvedValue(access && { id: 'u1', email: 'a@kalvium.com', name: 'A', lsq_user_id: 'L1', access, groups: ['Team Hema'] });
};

test('/api/me needs a token', async () => {
  expect((await request(app).get('/api/me')).status).toBe(401);
});

test('/api/me: 403 when no active LSQ user has the email', async () => {
  as(null);
  const res = await request(app).get('/api/me').set('Authorization', 'Bearer t-none');
  expect(res.status).toBe(403);
  expect(res.body.error).toMatch(/a@kalvium.com/);
});

test('/api/me returns the linked LSQ profile', async () => {
  as('associate');
  const res = await request(app).get('/api/me').set('Authorization', 'Bearer t-assoc');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ lsqUserId: 'L1', access: 'associate', groups: ['Team Hema'] });
});

test('/api/lists: associates are refused, managers get the dialer Lists', async () => {
  as('associate');
  expect((await request(app).get('/api/lists').set('Authorization', 'Bearer t-assoc2')).status).toBe(403);

  as('manager');
  getDialerLists.mockResolvedValue([{ id: 'x', name: 'Dialer – Fresh' }]);
  const res = await request(app).get('/api/lists').set('Authorization', 'Bearer t-mgr');
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ id: 'x', name: 'Dialer – Fresh' }]);
});

test('/api/disposition saves a dial for the caller and checks the body', async () => {
  as('associate');
  const post = body => request(app).post('/api/disposition').set('Authorization', 'Bearer t-disp').send(body);

  expect((await post({ outcome: 'no_answer' })).status).toBe(400);
  expect((await post({ prospectId: 'p1', outcome: 'maybe' })).status).toBe(400);
  expect((await post({ prospectId: 'p1', outcome: 'interested', talkSeconds: -3 })).status).toBe(400);
  expect((await post({ prospectId: 'p1', outcome: 'interested', startedAt: 'yesterday-ish' })).status).toBe(400);
  expect(inserted).toHaveLength(0);

  const res = await post({ prospectId: 'p1', phone: '+91-900', outcome: 'no_answer', talkSeconds: 0, startedAt: '2026-11-03T10:00:00Z' });
  expect(res.status).toBe(201);
  expect(inserted).toEqual([expect.objectContaining({
    user_id: 'u1', rule_id: null, prospect_id: 'p1', outcome: 'no_answer', talk_seconds: 0, started_at: '2026-11-03T10:00:00.000Z',
  })]);
});

test('/api/disposition for HR posts the activity first; a failed post saves nothing', async () => {
  const activity = require('../services/activity');
  const form = jest.spyOn(activity, 'getForm').mockResolvedValue({
    fields: [{ schema: 'mx_Custom_1', label: 'Call Connected', type: 'dropdown', options: ['Yes', 'No'] }],
  });
  const lsq = jest.spyOn(activity, 'postActivity');
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u2', email: 'hr@kalvium.com' } }, error: null });
  getProfile.mockResolvedValue({ id: 'u2', email: 'hr@kalvium.com', lsq_user_id: 'L2', access: 'associate', groups: ['Team HR'] });
  const post = body => request(app).post('/api/disposition').set('Authorization', 'Bearer t-hr').send({ prospectId: 'p2', talkSeconds: 0, ...body });
  inserted.length = 0;

  expect((await post({ outcome: 'no_answer' })).status).toBe(400); // HR must send the activity
  expect((await post({ outcome: 'no_answer', activity: { mx_Custom_1: 'Maybe' } })).status).toBe(400);

  lsq.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 500, data: { ExceptionMessage: 'LSQ down' } } }));
  const failed = await post({ outcome: 'no_answer', activity: { mx_Custom_1: 'No' } });
  expect(failed.status).toBe(502);
  expect(failed.body.error).toMatch(/LSQ down/);
  expect(inserted).toHaveLength(0);

  lsq.mockResolvedValueOnce('act-9');
  const ok = await post({ outcome: 'no_answer', activity: { mx_Custom_1: 'No' } });
  expect(ok.body).toEqual({ ok: true, activityId: 'act-9' });
  expect(lsq).toHaveBeenLastCalledWith(expect.objectContaining({ event: 263, prospectId: 'p2', ownerId: 'L2', fields: [{ SchemaName: 'mx_Custom_1', Value: 'No' }] }));
  expect(inserted).toHaveLength(1);
  form.mockRestore(); lsq.mockRestore();
});

test('the profile is read once a minute per user, not on every request', async () => {
  as('associate');
  getProfile.mockClear();
  await request(app).get('/api/me').set('Authorization', 'Bearer t-cache');
  await request(app).get('/api/me').set('Authorization', 'Bearer t-cache');
  expect(getProfile).toHaveBeenCalledTimes(1);
});
