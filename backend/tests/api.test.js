jest.mock('../config/supabase', () => ({ auth: { getUser: jest.fn() } }));
jest.mock('../services/profile', () => ({ getProfile: jest.fn() }));
jest.mock('../services/lsq_lists', () => ({ getDialerLists: jest.fn() }));
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
