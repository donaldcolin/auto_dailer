jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn() }, lsqUrl: p => p }));
const { pendingPushes } = require('../services/pushed');

const lead = (id, owner = 'L1') => ({ prospectId: id, name: id, phone: '9', stage: 'New Lead', ownerId: owner });
const push = (id, at) => ({ activityId: `a-${id}-${at}`, prospectId: id, pushedAt: `2026-11-03T${at}:00.000Z` });

test('keeps only leads the associate owns and that have a phone', () => {
  const owned = [lead('mine'), { ...lead('nophone'), phone: null }];
  const out = pendingPushes([push('mine', '05:00'), push('nophone', '05:00'), push('someone-else', '05:00')], owned, []);
  expect(out.map(l => l.prospectId)).toEqual(['mine']);
  expect(out[0]).toMatchObject({ pushed: true, pushedAt: '2026-11-03T05:00:00.000Z' });
});

test('dialed after the push = done; dialed before it (then pushed again) = still queued', () => {
  const owned = [lead('done'), lead('repushed')];
  const attempts = [
    { prospect_id: 'done', started_at: '2026-11-03T06:00:00Z' },
    { prospect_id: 'repushed', started_at: '2026-11-03T04:00:00Z' },
  ];
  const out = pendingPushes([push('done', '05:00'), push('repushed', '05:00')], owned, attempts);
  expect(out.map(l => l.prospectId)).toEqual(['repushed']);
});

test('a lead pushed twice counts once, from its latest push', () => {
  const owned = [lead('twice')];
  const attempts = [{ prospect_id: 'twice', started_at: '2026-11-03T06:00:00Z' }]; // between the two pushes
  const out = pendingPushes([push('twice', '05:00'), push('twice', '07:00')], owned, attempts);
  expect(out).toHaveLength(1);
  expect(out[0].pushedAt).toBe('2026-11-03T07:00:00.000Z');
});

test('oldest push first', () => {
  const owned = [lead('late'), lead('early'), lead('mid')];
  const out = pendingPushes([push('late', '09:00'), push('early', '05:00'), push('mid', '07:00')], owned, []);
  expect(out.map(l => l.prospectId)).toEqual(['early', 'mid', 'late']);
});
