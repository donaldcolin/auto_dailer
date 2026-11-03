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

// Each test uses a different token so the auth middleware's token cache doesn't leak between tests.
const as = (access) => {
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
