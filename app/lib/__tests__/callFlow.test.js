import { useDialer } from '../dialerStore';
import { createCallFlow } from '../callFlow';

const lead = (id) => ({ prospectId: id, name: id.toUpperCase(), phone: `+91-90000000${id.charCodeAt(0) % 10}` });

// A flow wired to stand-ins for the phone, the server and the outbox. `replies` maps a URL start to its reply.
function setup({ leads = ['a', 'b'], prefs = {}, replies = {} } = {}) {
  useDialer.setState(useDialer.getInitialState(), true);
  const calls = [];
  const api = jest.fn(async (url, opts) => {
    calls.push(url);
    const key = Object.keys(replies).find((k) => url.startsWith(k));
    if (key) return typeof replies[key] === 'function' ? replies[key](url, opts) : replies[key];
    if (url.startsWith('/api/queue?')) return { leads: leads.map(lead), rule: null, source: 'own', upcoming: [] };
    return {};
  });
  const Dialer = {
    listSims: () => [], placeCall: jest.fn(), isInCall: () => false, startIncomingListener: () => {},
    lastOutgoingCall: jest.fn(async () => null), lastIncomingCall: jest.fn(async () => null),
  };
  const enqueue = jest.fn();
  const flow = createCallFlow({
    me: { email: 'a@kalvium.com', mode: 'sales' }, api, Dialer, enqueue, flush: async () => {}, waitingLeads: () => new Set(),
    loadPrefs: () => prefs, savePrefs: () => {}, startValues: (form, connected) => ({ Status: connected }), rememberSticky: () => {},
    sleep: async () => {},
  });
  useDialer.setState({ form: { name: 'Auto Dailer - BDA activity', connected: { schema: 'Status' } } });
  return { flow, api, calls, Dialer, enqueue, S: useDialer.getState };
}

test('skip during the countdown: the next lead is dialed, never the skipped one', async () => {
  const { flow, Dialer, S } = setup();
  await flow.start();
  expect(S().lead.prospectId).toBe('a');
  flow.skip();
  await Promise.resolve();
  expect(S().lead.prospectId).toBe('b');
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  expect(Dialer.placeCall).toHaveBeenCalledTimes(1);
  expect(Dialer.placeCall.mock.calls[0][0]).toBe(lead('b').phone.replace(/[^\d+]/g, ''));
});

test('only skipped leads left: pauses instead of dialing', async () => {
  const { flow, Dialer, S } = setup({ leads: ['a'] });
  await flow.start();
  flow.skip();
  expect(S().phase).toBe('paused');
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  expect(Dialer.placeCall).not.toHaveBeenCalled();
});

test('a queue reply for a view the person has left is ignored', async () => {
  let release;
  const { flow, S } = setup({
    replies: {
      '/api/queue?view=v1': () => new Promise((r) => { release = () => r({ leads: [lead('x')], rule: null, source: 'view', upcoming: [] }); }),
      '/api/queue?view=v2': { leads: [lead('y')], rule: null, source: 'view', upcoming: [] },
    },
  });
  flow.pickView('v1');
  await flow.pickView('v2');
  await new Promise((r) => setTimeout(r, 0));
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(S().view).toBe('v2');
  expect(S().queueInfo.leads.map((l) => l.prospectId)).toEqual(['y']);
});

test('an answered incoming call during a form waits, then opens after save', async () => {
  const { flow, S } = setup();
  await flow.start();
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  useDialer.setState({ phase: 'outcome' });
  flow.openIncoming({ lead: lead('z'), seconds: 30, at: Date.now() });
  expect(S().pendingIncoming.lead.prospectId).toBe('z');
  expect(S().lead.prospectId).toBe('a');
  await flow.submit({ Status: 'Yes' });
  expect(S().lead.prospectId).toBe('z');
  expect(S().callback).toBe('Called you');
  expect(S().phase).toBe('outcome');
});

test('call end: the call-log row sets talk time and opens outcome or reason', async () => {
  const { flow, Dialer, S } = setup();
  await flow.start();
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  Dialer.lastOutgoingCall.mockResolvedValueOnce({ durationSec: 0 });
  await flow.finishCall(true);
  expect(S().phase).toBe('reason');

  await flow.start();
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  Dialer.lastOutgoingCall.mockResolvedValueOnce({ durationSec: 12 });
  await flow.finishCall(true);
  expect(S().phase).toBe('outcome');
  expect(S().talkSeconds).toBe(12);
});

test('laptop opens once per lead, at the countdown when chosen', async () => {
  const { flow, calls } = setup({ prefs: { autoLaptop: true, laptopWhen: 'countdown' } });
  await flow.start();
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  expect(calls.filter((u) => u.includes('open-on-laptop'))).toEqual(['/api/lead/a/open-on-laptop']);
});

test('a save marks the lead handled and sends it through the outbox', async () => {
  const { flow, enqueue, S } = setup();
  await flow.start();
  useDialer.setState({ countdown: 0 }); // the countdown ran out
  flow.dial();
  useDialer.setState({ phase: 'outcome', talkSeconds: 9 });
  await flow.submit({ Status: 'Yes' });
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ prospectId: 'a', outcome: 'connected', talkSeconds: 9 }));
  expect(S().handled).toContain('a');
  expect(S().lead.prospectId).toBe('b');
});

test('Refresh leads leaves Settings and other screens as they are', async () => {
  const { flow, S } = setup();
  useDialer.setState({ prefsOpen: 'menu' });
  await flow.refreshNow();
  expect(S().prefsOpen).toBe('menu');
});

test("a mode change never keeps the other team's form while the new one loads", async () => {
  const { flow, S } = setup({ replies: { '/api/activity-form': () => new Promise(() => {}) } });
  useDialer.setState({ form: { name: 'HR' }, formMode: 'hr' });
  flow.loadForm(); // me.mode is 'sales'
  expect(S().form).toBeNull();
  expect(S().formState).toBe('loading');
});

test('dial does nothing unless the countdown has reached 0', async () => {
  const { flow, Dialer } = setup();
  await flow.start();
  useDialer.setState({ countdown: 3 });
  flow.dial();
  expect(Dialer.placeCall).not.toHaveBeenCalled();
});
