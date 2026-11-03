jest.mock('../config/supabase', () => ({}));
jest.mock('../services/lsq_users', () => ({ fetchLsqUsers: jest.fn() }));
jest.mock('../services/lsq_lists', () => ({ getDialerLists: jest.fn() }));
jest.mock('../services/team', () => ({ manageableGroups: jest.fn() }));
const { fetchLsqUsers } = require('../services/lsq_users');
const { getDialerLists } = require('../services/lsq_lists');
const { manageableGroups } = require('../services/team');
const { istNow, pickActiveRule, validateRule } = require('../services/rules');

// Tuesday 2026-11-03, 16:30 IST
const at = (hhmm) => new Date(`2026-11-03T${hhmm}:00+05:30`);
const me = { id: 'u1', lsq_user_id: 'L1', groups: ['Team Hema'] };
const rule = (id, type, target, start, days = [2]) => ({ id, target_type: type, target_id: target, start_time: `${start}:00`, days });

test('istNow reads the weekday, time and midnight in IST', () => {
  expect(istNow(new Date('2026-11-02T20:00:00Z'))).toEqual({ day: 2, time: '01:30', midnightIso: '2026-11-03T00:00:00+05:30' });
});

test('pickActiveRule: latest start time that has passed', () => {
  const rules = [rule('fresh', 'group', 'Team Hema', '09:00'), rule('callback', 'group', 'Team Hema', '16:00')];
  expect(pickActiveRule(rules, me, at('10:00')).id).toBe('fresh');
  expect(pickActiveRule(rules, me, at('16:00')).id).toBe('callback');
  expect(pickActiveRule(rules, me, at('08:59'))).toBeNull();
});

test('pickActiveRule: the associate rule beats the group rule at the same time', () => {
  const rules = [rule('team', 'group', 'Team Hema', '16:00'), rule('mine', 'user', 'L1', '16:00')];
  expect(pickActiveRule(rules, me, at('16:30')).id).toBe('mine');
  expect(pickActiveRule([...rules].reverse(), me, at('16:30')).id).toBe('mine');
});

test('pickActiveRule: ignores other days, other people and other groups', () => {
  const rules = [
    rule('wed', 'group', 'Team Hema', '09:00', [3]),
    rule('other', 'user', 'L2', '09:00'),
    rule('otherTeam', 'group', 'Team Muthu', '09:00'),
  ];
  expect(pickActiveRule(rules, me, at('12:00'))).toBeNull();
});

describe('validateRule', () => {
  const tl = { id: 'tl1', access: 'tl', tlGroups: ['Team Hema'] };
  const body = { targetType: 'group', targetId: 'Team Hema', listId: 'list1', startTime: '16:00', days: [1, 2, 2] };
  beforeEach(() => {
    manageableGroups.mockResolvedValue(['Team Hema']);
    getDialerLists.mockResolvedValue([{ id: 'list1', name: 'Dialer – Callback' }]);
    fetchLsqUsers.mockResolvedValue([
      { ID: 'A1', StatusCode: 0, MemberOfGroups: ['Team Hema'] },
      { ID: 'B1', StatusCode: 0, MemberOfGroups: ['Team Muthu'] },
    ]);
  });

  test('accepts a rule for the TL\'s own group and cleans up days', async () => {
    const { rule, error } = await validateRule(body, tl);
    expect(error).toBeUndefined();
    expect(rule).toMatchObject({ target_type: 'group', target_id: 'Team Hema', list_name: 'Dialer – Callback', days: [1, 2] });
  });

  test('refuses groups and associates the TL does not manage', async () => {
    expect((await validateRule({ ...body, targetId: 'Team Muthu' }, tl)).error).toMatch(/don't manage/);
    expect((await validateRule({ ...body, targetType: 'user', targetId: 'B1' }, tl)).error).toMatch(/isn't in a group/);
    expect((await validateRule({ ...body, targetType: 'user', targetId: 'A1' }, tl)).error).toBeUndefined();
  });

  test('a manager can target any active associate, even one in no group', async () => {
    fetchLsqUsers.mockResolvedValue([{ ID: 'C1', StatusCode: 0, MemberOfGroups: [] }]);
    const manager = { id: 'm1', access: 'manager' };
    expect((await validateRule({ ...body, targetType: 'user', targetId: 'C1' }, manager)).error).toBeUndefined();
    expect((await validateRule({ ...body, targetType: 'user', targetId: 'C1' }, tl)).error).toMatch(/isn't in a group/);
  });

  test('refuses bad times, days and Lists', async () => {
    expect((await validateRule({ ...body, startTime: '4pm' }, tl)).error).toMatch(/HH:MM/);
    expect((await validateRule({ ...body, days: [] }, tl)).error).toMatch(/days/);
    expect((await validateRule({ ...body, days: [7] }, tl)).error).toMatch(/days/);
    expect((await validateRule({ ...body, listId: 'static-list' }, tl)).error).toMatch(/Dialer/);
  });
});
