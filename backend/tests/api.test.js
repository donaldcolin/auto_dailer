// No test may reach the real LSQ.
jest.mock('../config/lsq', () => ({ lsqClient: { get: jest.fn(), post: jest.fn() }, lsqUrl: p => p }));
const inserted = [];
const mockModeSaves = [];
jest.mock('../config/supabase', () => ({
  auth: { getUser: jest.fn() },
  from: () => ({
    insert: async row => (inserted.push(row), { error: null }),
    update: row => ({ eq: () => ({ is: () => ({ select: async () => (mockModeSaves.push(row), { data: [{ id: 'u1' }], error: null }) }) }) }),
  }),
}));
jest.mock('../services/profile', () => ({ getProfile: jest.fn() }));
jest.mock('../services/lsq_lists', () => ({ getDialerLists: jest.fn() }));
jest.mock('../services/team', () => ({ withTeamLead: async p => ({ ...p, tlGroups: [] }) }));
jest.mock('../services/lsq_keys', () => ({
  keyHeaders: () => ({}), hasKeys: jest.fn(async () => false), getKeys: jest.fn(), saveKeys: jest.fn(), keysWork: jest.fn(), markVerified: jest.fn(async () => {}),
}));
const request = require('supertest');
const supabase = require('../config/supabase');
const { getProfile } = require('../services/profile');
const { getDialerLists } = require('../services/lsq_lists');
const app = require('../server');
const { clearAuthCache } = require('../middleware/auth');

// Each test uses a different token so the auth middleware's token cache doesn't leak between tests.
const as = (access, mode = 'sales') => {
  clearAuthCache();
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@kalvium.com' } }, error: null });
  getProfile.mockResolvedValue(access && { id: 'u1', email: 'a@kalvium.com', name: 'A', lsq_user_id: 'L1', access, groups: ['Team Hema'], mode });
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
  expect((await post({ prospectId: 'p1', outcome: 'skipped', talkSeconds: -3 })).status).toBe(400);
  expect((await post({ prospectId: 'p1', outcome: 'skipped', startedAt: 'yesterday-ish' })).status).toBe(400);
  expect(inserted).toHaveLength(0);

  const res = await post({ prospectId: 'p1', phone: '+91-900', outcome: 'skipped', talkSeconds: 0, startedAt: '2026-11-03T10:00:00Z' });
  expect(res.status).toBe(201);
  expect(inserted).toEqual([expect.objectContaining({
    user_id: 'u1', rule_id: null, prospect_id: 'p1', outcome: 'skipped', talk_seconds: 0, started_at: '2026-11-03T10:00:00.000Z',
  })]);
});

describe('/api/disposition posts the activity with the caller\'s own keys', () => {
  const activity = require('../services/activity');
  const lsqKeys = require('../services/lsq_keys');
  const post = body => request(app).post('/api/disposition').set('Authorization', 'Bearer t-hr').send({ prospectId: 'p2', talkSeconds: 0, ...body });
  const marked = { outcome: 'no_answer', activity: { mx_Custom_1: 'No' } };
  let lsq;
  beforeEach(() => {
    jest.spyOn(activity, 'getForm').mockResolvedValue({ fields: [{ schema: 'mx_Custom_1', label: 'Call Connected', type: 'dropdown', options: ['Yes', 'No'] }] });
    jest.spyOn(activity, 'activityCreatorEmail').mockResolvedValue('a@kalvium.com');
    lsq = jest.spyOn(activity, 'postActivity');
    lsqKeys.getKeys.mockResolvedValue({ accessKey: 'ak', secretKey: 'sk', verified: true });
    as('associate', 'hr');
    inserted.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  test('checks the form; a failed post saves nothing', async () => {
    expect((await post({ outcome: 'no_answer' })).status).toBe(400);
    expect((await post({ outcome: 'no_answer', activity: { mx_Custom_1: 'Maybe' } })).status).toBe(400);

    jest.spyOn(console, 'error').mockImplementation(() => {});
    lsq.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 500, data: { ExceptionMessage: 'LSQ down' } } }));
    const failed = await post(marked);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatch(/LSQ down/);
    expect(inserted).toHaveLength(0);
  });

  test('saves with the personal keys and the mode\'s activity', async () => {
    lsq.mockResolvedValueOnce('act-9');
    const ok = await post(marked);
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toMatch(/ak|sk/);
    expect(lsq).toHaveBeenLastCalledWith(expect.objectContaining({
      keys: expect.objectContaining({ accessKey: 'ak', secretKey: 'sk' }), event: 284, prospectId: 'p2', ownerId: 'L1', fields: [{ SchemaName: 'mx_Custom_1', Value: 'No' }],
    }));
    expect(inserted).toHaveLength(1);
  });

  test('no key, or a key LSQ refuses: nothing saved, the app is told to update it, no org-key fallback', async () => {
    lsqKeys.getKeys.mockResolvedValueOnce(null);
    const none = await post(marked);
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('lsq_key_rejected');
    expect(lsq).not.toHaveBeenCalled();

    jest.spyOn(console, 'error').mockImplementation(() => {});
    lsq.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 401, data: {} } }));
    const refused = await post(marked);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('lsq_key_rejected');
    expect(inserted).toHaveLength(0);
  });

  test('new keys: the first post checks who LSQ credited; a colleague\'s keys are not marked verified', async () => {
    lsqKeys.markVerified.mockClear();
    lsqKeys.getKeys.mockResolvedValue({ accessKey: 'ak', secretKey: 'sk', verified: false });
    lsq.mockResolvedValue('act-1');
    await post(marked);
    await new Promise(r => setImmediate(r));
    expect(lsqKeys.markVerified).toHaveBeenCalledWith('u1');

    lsqKeys.markVerified.mockClear();
    activity.activityCreatorEmail.mockResolvedValue('someone.else@kalvium.com');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    await post(marked);
    await new Promise(r => setImmediate(r));
    expect(lsqKeys.markVerified).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/someone.else/);
  });

  test('before setup nothing can be marked', async () => {
    as('associate', null);
    const res = await post(marked);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('setup_required');
  });
});

describe('/api/setup', () => {
  const lsqKeys = require('../services/lsq_keys');
  const send = (method, url, body) => request(app)[method](url).set('Authorization', 'Bearer t-setup').send(body);
  const keys = { accessKey: ' ak ', secretKey: 'sk' };
  beforeEach(() => { mockModeSaves.length = 0; lsqKeys.saveKeys.mockClear(); lsqKeys.keysWork.mockResolvedValue(true); delete process.env.SALES_READY; });

  test('sets the team once with keys LSQ accepts; keys are trimmed and never returned', async () => {
    as('associate', null);
    const res = await send('post', '/api/setup', { mode: 'hr', ...keys });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(lsqKeys.saveKeys).toHaveBeenCalledWith('u1', { accessKey: 'ak', secretKey: 'sk' });
    expect(mockModeSaves).toEqual([{ mode: 'hr' }]);
  });

  test('the team can\'t change after setup', async () => {
    as('associate', 'hr');
    expect((await send('post', '/api/setup', { mode: 'sales', ...keys })).status).toBe(409);
    expect(mockModeSaves).toHaveLength(0);
  });

  test('wrong keys are refused and not saved; the team stays open', async () => {
    as('associate', null);
    lsqKeys.keysWork.mockResolvedValue(false);
    const res = await send('post', '/api/setup', { mode: 'hr', ...keys });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('lsq_key_rejected');
    expect(lsqKeys.saveKeys).not.toHaveBeenCalled();
    expect(mockModeSaves).toHaveLength(0);
  });

  test('LSQ being down is not reported as a wrong key', async () => {
    as('associate', null);
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});
    lsqKeys.keysWork.mockRejectedValue(new Error('timeout'));
    expect((await send('post', '/api/setup', { mode: 'hr', ...keys })).status).toBe(502);
  });

  test('Sales is closed until SALES_READY', async () => {
    as('associate', null);
    expect((await send('post', '/api/setup', { mode: 'sales', ...keys })).status).toBe(403);
    process.env.SALES_READY = '1';
    expect((await send('post', '/api/setup', { mode: 'sales', ...keys })).status).toBe(201);
  });

  test('updating keys never touches the team', async () => {
    as('associate', 'hr');
    const res = await send('put', '/api/setup/keys', { ...keys, mode: 'sales' });
    expect(res.status).toBe(200);
    expect(lsqKeys.saveKeys).toHaveBeenCalled();
    expect(mockModeSaves).toHaveLength(0);
  });
});

test('the profile is read once a minute per user, not on every request', async () => {
  as('associate');
  getProfile.mockClear();
  await request(app).get('/api/me').set('Authorization', 'Bearer t-cache');
  await request(app).get('/api/me').set('Authorization', 'Bearer t-cache');
  expect(getProfile).toHaveBeenCalledTimes(1);
});

test('/api/lead/:id/history: an associate only sees their own leads', async () => {
  const queue = require('../services/queue');
  const history = require('../services/history');
  const byIds = jest.spyOn(queue, 'readLeadsByIds');
  const hist = jest.spyOn(history, 'leadHistory').mockResolvedValue([{ what: 'HR Activity' }]);
  as('associate'); // lsq_user_id L1
  const get = id => request(app).get(`/api/lead/${id}/history`).set('Authorization', 'Bearer t-hist');

  byIds.mockResolvedValueOnce([{ prospectId: 'theirs', ownerId: 'L9' }]);
  expect((await get('theirs')).status).toBe(404);
  byIds.mockResolvedValueOnce([{ prospectId: 'mine', ownerId: 'L1' }]);
  const ok = await get('mine');
  expect(ok.status).toBe(200);
  expect(ok.body.history).toEqual([{ what: 'HR Activity' }]);
  byIds.mockRestore(); hist.mockRestore();
});
