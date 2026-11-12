// No test may reach the real LSQ.
jest.mock('../config/lsq', () => ({ lsqClient: { get: jest.fn(), post: jest.fn() }, lsqUrl: p => p }));
const mockRows = { attempts: [], inserted: [] };
jest.mock('../config/supabase', () => {
  const chain = { select: () => chain, eq: () => chain, gte: () => chain, neq: () => chain, order: async () => ({ data: mockRows.attempts, error: null }) };
  return {
    auth: { getUser: jest.fn() },
    from: table => (table === 'laptop_opens' ? { insert: async row => (mockRows.inserted.push(row), { error: null }) } : chain),
  };
});
jest.mock('../services/profile', () => ({ getProfile: jest.fn() }));
jest.mock('../services/team', () => ({ withTeamLead: async p => ({ ...p, tlGroups: [] }) }));
jest.mock('../services/queue', () => ({ readLeadsByIds: jest.fn(), leadsByPhone: jest.fn() }));
const request = require('supertest');
const supabase = require('../config/supabase');
const { getProfile } = require('../services/profile');
const queue = require('../services/queue');
const app = require('../server');
const { clearAuthCache } = require('../middleware/auth');
const { istMidnight } = require('../routes/lead');

let n = 0;
const get = async (phone) => {
  clearAuthCache();
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@kalvium.com' } }, error: null });
  getProfile.mockResolvedValue({ id: 'u1', email: 'a@kalvium.com', lsq_user_id: 'L1', access: 'associate', groups: [], mode: 'hr' });
  return request(app).post('/api/lead/callback').send({ phone }).set('Authorization', `Bearer cb-${n++}`);
};
const lead = { prospectId: 'p1', name: 'Asha', phone: '+91-9876543210', ownerId: 'L1' };

test('a number missed today calls back: its lead, matched on the last 10 digits', async () => {
  mockRows.attempts = [{ prospect_id: 'p1', phone: '+91-9876543210', outcome: 'no_answer' }];
  queue.readLeadsByIds.mockResolvedValue([lead]);
  expect((await get('09876543210')).body).toEqual({ lead });
});

test('no lead when the latest dial to that number connected, or it was never dialed', async () => {
  queue.readLeadsByIds.mockResolvedValue([lead]);
  mockRows.attempts = [{ prospect_id: 'p1', phone: '9876543210', outcome: 'connected' }, { prospect_id: 'p1', phone: '9876543210', outcome: 'no_answer' }];
  expect((await get('+919876543210')).body).toEqual({ lead: null });
  mockRows.attempts = [{ prospect_id: 'p2', phone: '9000000000', outcome: 'no_answer' }];
  expect((await get('+919876543210')).body).toEqual({ lead: null });
  expect((await get('123')).body).toEqual({ lead: null });
});

test("no lead once it belongs to someone else", async () => {
  mockRows.attempts = [{ prospect_id: 'p1', phone: '9876543210', outcome: 'no_answer' }];
  queue.readLeadsByIds.mockResolvedValue([{ ...lead, ownerId: 'L9' }]);
  expect((await get('9876543210')).body).toEqual({ lead: null });
});

test('open-on-laptop stores a request for the caller only', async () => {
  clearAuthCache();
  const res = await request(app).post('/api/lead/p1/open-on-laptop').set('Authorization', 'Bearer cb-open');
  expect(res.status).toBe(201);
  expect(mockRows.inserted).toEqual([{ user_id: 'u1', prospect_id: 'p1' }]);
});

test('istMidnight: IST day boundaries', () => {
  expect(istMidnight(new Date('2026-11-10T20:00:00Z')).toISOString()).toBe('2026-11-10T18:30:00.000Z'); // 01:30 IST on the 11th
  expect(istMidnight(new Date('2026-11-10T18:00:00Z')).toISOString()).toBe('2026-11-09T18:30:00.000Z'); // 23:30 IST on the 10th
});

describe('identify: any of the person\'s leads calling in', () => {
  const ask = async (phone, profile = {}) => {
    clearAuthCache();
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@kalvium.com' } }, error: null });
    getProfile.mockResolvedValue({ id: 'u1', email: 'a@kalvium.com', lsq_user_id: 'L1', access: 'associate', groups: [], mode: 'hr', ...profile });
    return request(app).post('/api/lead/identify').send({ phone }).set('Authorization', `Bearer id-${n++}`);
  };
  beforeEach(() => { queue.leadsByPhone.mockReset(); queue.readLeadsByIds.mockReset(); });

  test('dialed today without connecting: that lead, marked as a callback, without an LSQ phone search', async () => {
    mockRows.attempts = [{ prospect_id: 'p1', phone: '+91-9876543210', outcome: 'no_answer' }];
    queue.readLeadsByIds.mockResolvedValue([lead]);
    expect((await ask('09876543210')).body).toEqual({ lead, calledBack: true });
    expect(queue.leadsByPhone).not.toHaveBeenCalled();
  });

  test('not dialed today: found by phone in LSQ, preferring the lead this person owns', async () => {
    mockRows.attempts = [];
    const other = { ...lead, prospectId: 'p2', ownerId: 'L9' };
    queue.leadsByPhone.mockResolvedValue([other, lead]);
    expect((await ask('9876543210')).body).toEqual({ lead, calledBack: false });
  });

  test('a number that is someone else\'s lead, or no lead, or not a phone: nothing', async () => {
    mockRows.attempts = [];
    queue.leadsByPhone.mockResolvedValue([{ ...lead, ownerId: 'L9' }]);
    expect((await ask('9876543210')).body).toEqual({ lead: null });
    queue.leadsByPhone.mockResolvedValue([]);
    expect((await ask('9876543210')).body).toEqual({ lead: null });
    expect((await ask('12345')).body).toEqual({ lead: null });
  });

  test('a TL is told about a lead someone else owns', async () => {
    mockRows.attempts = [];
    queue.leadsByPhone.mockResolvedValue([{ ...lead, ownerId: 'L9' }]);
    expect((await ask('9876543210', { access: 'tl' })).body.lead.prospectId).toBe('p1');
  });
});
