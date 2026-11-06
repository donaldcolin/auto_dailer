jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn() }, lsqUrl: p => p }));
const { lsqClient } = require('../config/lsq');
const { fetchPushes, pendingPushes } = require('../services/pushed');

const lead = (id, owner = 'L1') => ({ prospectId: id, name: id, phone: '9', stage: 'New Lead', ownerId: owner });
const push = (id, at) => ({ activityId: `a-${id}-${at}`, prospectId: id, pushedAt: `2026-11-03T${at}:00.000Z` });
const remove = (id, at) => ({ ...push(id, at), removed: true });

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

test('a remove after the push takes the lead out; a remove with no push does nothing', () => {
  const owned = [lead('undone'), lead('kept'), lead('never-pushed')];
  const out = pendingPushes([push('undone', '05:00'), remove('undone', '06:00'), push('kept', '05:00'), remove('never-pushed', '05:00')], owned, []);
  expect(out.map(l => l.prospectId)).toEqual(['kept']);
});

test('pushed again after a remove = back in the queue', () => {
  const out = pendingPushes([push('back', '05:00'), remove('back', '06:00'), push('back', '07:00')], [lead('back')], []);
  expect(out.map(l => l.pushedAt)).toEqual(['2026-11-03T07:00:00.000Z']);
});

test('a push and a remove in the same minute: the remove wins, in either order', () => {
  const owned = [lead('a'), lead('b')];
  const out = pendingPushes([push('a', '05:00'), remove('a', '05:00'), remove('b', '05:00'), push('b', '05:00')], owned, []);
  expect(out).toEqual([]);
});

test('fetchPushes: only Remove = Yes marks a remove, and custom fields are asked for', async () => {
  const row = (Id, Fields) => ({ Id, RelatedProspectId: Id, CreatedOn: '2026-11-03 05:00:00', Fields });
  lsqClient.post.mockResolvedValueOnce({ data: { ProspectActivities: [
    row('yes', [{ Key: 'mx_Custom_2', Value: 'Yes' }]),
    row('no', [{ Key: 'mx_Custom_2', Value: 'No' }]),
    row('blank', [{ Key: 'mx_Custom_2', Value: null }]),
    row('other-field', [{ Key: 'mx_Custom_1', Value: 'Yes' }]),
    row('no-fields'),
  ] } });
  const out = await fetchPushes();
  expect(Object.fromEntries(out.map(p => [p.activityId, p.removed]))).toEqual({ yes: true, no: false, blank: false, 'other-field': false, 'no-fields': false });
  expect(lsqClient.post.mock.calls[0][1].Parameter.IncludeCustomFields).toBe(1);
});
