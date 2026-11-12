import { api } from './api';

// Saves waiting to reach the backend, kept on the phone so the next lead never waits on LeadSquared
// and nothing is lost offline. [{ id, body }] in send order.
const KEY = 'outbox';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function store(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
}

// Leads with a save still waiting, so a reload of the queue doesn't offer them again.
export const waitingLeads = () => new Set(load().map((i) => i.body.prospectId));
export const waitingCount = () => load().length;

let sending = null;
let report = () => {};
// onProblem(message | null, code): shown by the dialer; null once everything is sent.
export function onOutboxProblem(fn) { report = fn; }

export function enqueue(body) {
  store([...load(), { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, body }]);
  return flush();
}

// Sends waiting saves in order. Stops at the first one that can't go yet and keeps it for the next try.
export function flush() {
  if (sending) return sending;
  sending = (async () => {
    for (;;) {
      const [item] = load();
      if (!item) { report(null); return; }
      try {
        // retry: the backend first checks LSQ for this save, in case it went through and only the reply was lost.
        await api('/api/disposition', { method: 'POST', body: item.tried ? { ...item.body, retry: true } : item.body });
      } catch (e) {
        // 4xx other than a refused key: the backend will never take it, so drop it and say so.
        const permanent = e.status >= 400 && e.status < 500 && e.code !== 'lsq_key_rejected';
        if (!permanent) {
          store(load().map((i) => (i.id === item.id ? { ...i, tried: true } : i)));
          const left = load().length;
          report(`${e.message} ${left} ${left === 1 ? 'save is' : 'saves are'} waiting and will be sent again.`, e.code);
          return;
        }
        report(`Not saved: ${e.message}`, e.code);
      }
      store(load().filter((i) => i.id !== item.id));
    }
  })().finally(() => { sending = null; });
  return sending;
}
