import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// The dialer's shared state, read with useDialer(selector) on screen and useDialer.getState() from timers, phone events
// and saves, so nothing reads a value left over from an earlier render. Only what lets the app open at once is kept on
// the phone (each view's last queue, the views, the form); never the phase, lead or call, so a restart opens the list.
const EMPTY_QUEUE = { leads: [], rule: null, source: null, upcoming: [] };
const SAVED = ['queues', 'views', 'form', 'formMode'];

// Persist writes on every change; most changes are the screen's (countdown ticks, typing), so this writes only when
// one of the saved parts is a new object, and skips turning the rest into JSON at all.
let lastSaved = {};
const storage = {
  getItem: (name) => { try { return JSON.parse(localStorage.getItem(name)); } catch { return null; } },
  setItem: (name, value) => {
    if (lastSaved.name === name && SAVED.every((k) => lastSaved.state?.[k] === value.state[k])) return;
    lastSaved = { name, state: value.state };
    try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
  },
  removeItem: (name) => { try { localStorage.removeItem(name); } catch {} },
};

export const useDialer = create(persist((set) => ({
  phase: 'idle', // idle | loading | countdown | calling | outcome | reason | paused | done
  lead: null,
  call: null, // { lead, since, startedAt, sawOffhook, finishing, ended, returnTo }
  queue: EMPTY_QUEUE, // the open view's
  queues: {}, // view id -> its last queue, so switching views is instant
  handled: [], // prospect ids saved since the last Start
  skipped: {}, // prospect id -> when it was skipped on this phone
  paused: false,
  view: 'own',
  views: null,
  form: null,
  formMode: null,
  values: {},
  talkSeconds: 0,
  callback: null,
  incoming: null, // { since, lookup } while a call rings in
  pendingIncoming: null, // an answered incoming call that waits for the form on screen
  // What the screens draw, set by the call flow.
  queueInfo: null, // { count, source, rule, leads, upcoming }: the open view's queue minus handled, skips last
  countdown: 5,
  held: false, // a finger on the lead screen: the countdown waits
  leadOpen: false,
  incomingLead: null, // the lead on an incoming call, named while it lasts
  saving: false,
  slow: false, // nothing on screen yet and LSQ is taking over a second
  refreshing: false,
  formState: 'loading', // loading | ready | failed
  error: null,
  toast: null,
  prefsOpen: null, // null | 'menu' | 'chooseSim'
  keyOpen: false,
  tab: null, // the list's 'pushed' | 'mine'; null = pushed when there are any

  setPhase: (phase) => set({ phase }),
  setLead: (lead) => set({ lead }),
  setQueue: (queue) => set((s) => ({ queue, queues: { ...s.queues, [s.view]: queue } })),
  markHandled: (id) => set((s) => {
    const { [id]: _, ...skipped } = s.skipped;
    return { handled: s.handled.includes(id) ? s.handled : [...s.handled, id], skipped };
  }),
  markSkipped: (id, at) => set((s) => ({ skipped: { ...s.skipped, [id]: at } })),
  resetHandled: () => set({ handled: [] }),
  setView: (view) => set((s) => ({ view, queue: s.queues[view] || EMPTY_QUEUE })),
  setViews: (views) => set({ views }),
  setForm: (form, formMode) => set({ form, formMode }),
  setValues: (values) => set({ values }),
}), {
  name: 'dialer',
  storage,
  partialize: (s) => ({ queues: s.queues, views: s.views, form: s.form, formMode: s.formMode }),
  // Only this person's saved parts, never what the last person left in memory.
  merge: (saved, current) => ({ ...current, queues: {}, views: null, form: null, formMode: null, ...(saved || {}) }),
  skipHydration: true, // read once the person is known (initDialer)
}));

// Point the saved state at this person and read it back. Called before the dialer first draws.
export async function initDialer(email) {
  lastSaved = {};
  useDialer.persist.setOptions({ name: `dialer-${email}` });
  await useDialer.persist.rehydrate();
}
