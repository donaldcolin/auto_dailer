// Each test loads the store fresh, the way the app does when it starts.
const load = () => { jest.resetModules(); return require('../dialerStore'); };

beforeEach(() => localStorage.clear());

test('after a restart the store opens idle with no lead or call, but keeps queues, views and form', async () => {
  let { useDialer, initDialer } = load();
  await initDialer('a@kalvium.com');
  const s = useDialer.getState();
  s.setPhase('calling');
  s.setLead({ prospectId: 'x' });
  useDialer.setState({ call: { lead: { prospectId: 'x' } } });
  s.setQueue({ leads: [{ prospectId: 'x' }], rule: null, source: 'own', upcoming: [] });
  s.setViews([{ id: 'own', name: 'My leads' }]);
  s.setForm({ event: 286, fields: [] }, 'sales');

  ({ useDialer, initDialer } = load());
  await initDialer('a@kalvium.com');
  const r = useDialer.getState();
  expect(r.phase).toBe('idle');
  expect(r.lead).toBeNull();
  expect(r.call).toBeNull();
  expect(r.queues.own.leads.map((l) => l.prospectId)).toEqual(['x']);
  expect(r.views).toEqual([{ id: 'own', name: 'My leads' }]);
  expect(r.form).toEqual({ event: 286, fields: [] });
});

test("one person never opens with another person's saved queue", async () => {
  let { useDialer, initDialer } = load();
  await initDialer('a@kalvium.com');
  useDialer.getState().setQueue({ leads: [{ prospectId: 'x' }], rule: null, source: 'own', upcoming: [] });
  ({ useDialer, initDialer } = load());
  await initDialer('b@kalvium.com');
  expect(useDialer.getState().queues).toEqual({});
});

test('markSkipped then markHandled leaves the lead handled only', () => {
  const { useDialer } = load();
  const s = useDialer.getState();
  s.markSkipped('a', 5);
  s.markHandled('a');
  expect(useDialer.getState().handled).toEqual(['a']);
  expect(useDialer.getState().skipped).toEqual({});
});

test('a switch of person in the same session never carries the last person\'s queue, views or form', async () => {
  const { useDialer, initDialer } = load();
  await initDialer('a@kalvium.com');
  useDialer.getState().setQueue({ leads: [{ prospectId: 'x' }], rule: null, source: 'own', upcoming: [] });
  useDialer.getState().setViews([{ id: 'own' }]);
  useDialer.getState().setForm({ event: 284 }, 'hr');
  await initDialer('b@kalvium.com');
  expect(useDialer.getState().queues).toEqual({});
  expect(useDialer.getState().views).toBeNull();
  expect(useDialer.getState().form).toBeNull();
});

test('screen-only changes (countdown, typing) write nothing to the phone', async () => {
  const { useDialer, initDialer } = load();
  await initDialer('a@kalvium.com');
  useDialer.getState().setQueue({ leads: [], rule: null, source: 'own', upcoming: [] });
  const spy = jest.spyOn(localStorage, 'setItem');
  useDialer.setState({ countdown: 3, held: true, values: { Status: 'Yes' }, toast: 'x' });
  expect(spy).not.toHaveBeenCalled();
  useDialer.getState().setViews([{ id: 'own' }]);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
