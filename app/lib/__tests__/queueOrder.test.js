import { pendingLeads } from '../queueOrder';

const L = (id) => ({ prospectId: id });

test('handled and waiting leads drop out; skipped go last, earliest skip first', () => {
  const out = pendingLeads(['a', 'b', 'c', 'd', 'e'].map(L), {
    handled: new Set(['b']), skipped: new Map([['a', 2], ['c', 1]]), waiting: new Set(['e']),
  });
  expect(out.map((l) => l.prospectId)).toEqual(['d', 'c', 'a']);
});

test('a skipped lead that is also handled is gone', () => {
  const out = pendingLeads(['a', 'b'].map(L), { handled: new Set(['a']), skipped: new Map([['a', 1]]), waiting: new Set() });
  expect(out.map((l) => l.prospectId)).toEqual(['b']);
});
