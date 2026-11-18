import { useDialer } from './dialerStore';
import { pendingLeads } from './queueOrder';

/**
 * The dialer's loop, moved out of DialerScreen: queue, countdown, dial, call end, save, skip, incoming calls, views.
 * Every read of current state goes through useDialer.getState(), so timers and phone events never act on a value left
 * over from an earlier render. Built once per screen; `deps` are the outside world, so tests can stand in for them.
 */
export function createCallFlow({
  me, api, Dialer, enqueue, flush, waitingLeads, loadPrefs, savePrefs, startValues, rememberSticky, countdownBar,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), COUNTDOWN_SEC = 5, now = () => Date.now(),
}) {
  const S = useDialer.getState;
  const set = useDialer.setState;
  const setPhase = (phase) => set({ phase });
  const setError = (v) => set((s) => ({ error: typeof v === 'function' ? v(s.error) : v }));
  let toastTimer = null;
  const showToast = (toast) => {
    set({ toast });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2500);
  };

  // The queue as last loaded, minus the leads handled since, skipped ones last. Moving to the next lead uses this list
  // straight away; the server reload runs in the background (it only adds a TL's new pushes).
  function pending() {
    const { queue, handled, skipped } = S();
    const left = pendingLeads(queue.leads, {
      handled: new Set(handled), skipped: new Map(Object.entries(skipped)), waiting: waitingLeads(),
    });
    set({ queueInfo: { count: left.length, source: queue.source, rule: queue.rule, leads: left, upcoming: queue.upcoming || [] } });
    return left;
  }

  // skipCache: re-read LSQ on the server too (menu → Refresh leads), so a TL's new leads show at once.
  async function loadQueue(skipCache = false) {
    const v = S().view;
    const q = await api(`/api/queue?view=${encodeURIComponent(v)}${skipCache ? '&fresh=1' : ''}`);
    if (v !== S().view) return pending(); // the person switched tabs while this loaded
    // The tab's List was renamed or deleted: back to My leads.
    if (v !== 'own' && q.source === 'own') { pickView('own', false); showToast('That view is gone; showing My leads'); }
    S().setQueue({ leads: q.leads, rule: q.rule, source: q.source, upcoming: q.upcoming || [] });
    return pending();
  }

  // Names first (instant), then the lead counts on each chip (a person's first count reads their tasks: a few seconds),
  // then every view not on the phone yet is fetched quietly, so its first tap shows leads at once.
  function loadViews() {
    api('/api/queue/views').then((r) => {
      const old = S().views;
      S().setViews(r.views.map((v) => ({ ...v, count: old?.find((o) => o.id === v.id)?.count })));
      return api('/api/queue/views?counts=1');
    }).then((r) => { S().setViews(r.views); return prefetchViews(r.views); }).catch(() => {});
  }
  async function prefetchViews(list) {
    if (list.length < 2) return;
    for (const v of list) {
      if (v.id === S().view || S().queues[v.id]) continue;
      const q = await api(`/api/queue?view=${encodeURIComponent(v.id)}`); // one at a time: the counts call warmed the server
      set((s) => ({ queues: { ...s.queues, [v.id]: { leads: q.leads, rule: q.rule, source: q.source, upcoming: q.upcoming || [] } } }));
    }
  }

  // A spinner only when there's nothing on screen yet and LSQ takes over a second. A saved list refreshes silently.
  let loadSeq = 0;
  function loadShown(empty) {
    const seq = ++loadSeq;
    set({ slow: false });
    const t = empty && setTimeout(() => seq === loadSeq && set({ slow: true }), 1000);
    return loadQueue().finally(() => { clearTimeout(t); if (seq === loadSeq) set({ slow: false }); });
  }

  // A Smart View tab, like in LSQ: remembered on the phone, its leads shown at once and reloaded.
  function pickView(id, reload = true) {
    S().setView(id);
    savePrefs({ view: id });
    if (!reload) return;
    const last = S().queues[id];
    if (last) pending(); else set({ queueInfo: null });
    loadShown(!last).catch((e) => setError(e.message));
  }

  // The last form opens at once; the server's copy replaces it when it arrives.
  function loadForm() {
    const { form, formMode } = S();
    const last = formMode === me.mode ? form : null;
    set(last ? { form: last, formState: 'ready' } : { form: null, formState: 'loading' }); // never the other team's form
    api('/api/activity-form')
      .then((r) => { set({ formState: r.form ? 'ready' : 'failed' }); if (r.form) S().setForm(r.form, me.mode); })
      .catch(() => { if (!last) set({ formState: 'failed' }); });
  }

  async function refreshNow() {
    set({ refreshing: true });
    try {
      loadViews();
      const left = await loadQueue(true);
      setError(null);
      if (left.length && S().phase === 'done') setPhase('idle');
      showToast(`Leads refreshed: ${left.length} to call`);
    } catch (e) {
      setError(`Could not refresh: ${e.message}`);
    } finally {
      set({ refreshing: false });
    }
  }

  // Reload the list only; dialing always waits for Start.
  async function refresh(offlineText) {
    if (S().views?.length > 1) api('/api/queue/views?counts=1').then((r) => S().setViews(r.views)).catch(() => {});
    const left = await loadQueue();
    if (offlineText) setError((e) => (e?.includes(offlineText) ? null : e)); // back online
    if (left.length && S().phase === 'done') setPhase('idle');
  }

  async function next(fresh = false) {
    const waiting = S().pendingIncoming; // a lead's call answered while another was being marked: that form first
    if (waiting) { set({ pendingIncoming: null }); openIncoming(waiting, 'next'); return; }
    if (S().paused) { setPhase('paused'); return; }
    setError(null);
    let left = pending();
    if (fresh || !left.length) {
      setPhase('loading');
      try {
        left = await loadQueue();
      } catch (e) {
        setError(e.message);
        setPhase('idle');
        return;
      }
    } else {
      loadQueue().catch(() => {});
    }
    if (!left.length) { set({ lead: null, phase: 'done' }); return; }
    countdownBar?.setValue(1);
    set({ callback: null, lead: { ...left[0], ruleId: S().queue.rule?.id || null }, countdown: COUNTDOWN_SEC, held: false, leadOpen: false, phase: 'countdown' });
    // "Open leads on my laptop" at the countdown (Settings): the lead is up on the laptop before the call starts.
    const prefs = loadPrefs();
    if (prefs.autoLaptop && prefs.laptopWhen === 'countdown') autoOpenOnLaptop(left[0].prospectId);
  }

  // Each lead opens on the laptop once, whichever moment the setting picks.
  let laptopOpened = null;
  function autoOpenOnLaptop(prospectId) {
    if (laptopOpened === prospectId) return;
    laptopOpened = prospectId;
    api(`/api/lead/${encodeURIComponent(prospectId)}/open-on-laptop`, { method: 'POST' }).catch(() => {});
  }

  let simAsked = false;
  function dial() {
    const { lead } = S();
    if (!lead || S().phase !== 'countdown' || S().countdown !== 0) return;
    const prefs = loadPrefs();
    let sims = [];
    try { sims = Dialer.listSims(); } catch {}
    // Dual SIM and none chosen: ask once, holding the countdown; closing Settings dials.
    if (sims.length > 1 && !sims.some((s) => s.id === prefs.simId) && !simAsked) {
      simAsked = true;
      set({ held: true, prefsOpen: 'chooseSim' });
      return;
    }
    set({ call: { lead, since: now() - 2000, startedAt: new Date(now()).toISOString(), sawOffhook: false, finishing: false }, phase: 'calling' });
    // Sent before dialing: once the phone app takes the screen, Android may hold this app's requests back.
    if (prefs.autoLaptop) autoOpenOnLaptop(lead.prospectId);
    try {
      Dialer.placeCall(dialable(lead.phone), sims.some((s) => s.id === prefs.simId) ? prefs.simId : null);
    } catch (e) {
      setError(`Could not place the call: ${e.message}`);
      set({ call: null, phase: 'idle' });
    }
  }

  // The call log is the source of truth: no row yet means the call is still going.
  // `ended` is set by the IDLE event (or the "Call ended" button) even while a check from
  // AppState is already running, so that check keeps waiting for the row instead of giving up.
  async function finishCall(ended) {
    const call = S().call;
    if (!call) return;
    if (ended) call.ended = true;
    if (call.finishing) return;
    call.finishing = true;
    let row = null;
    // Checked every 250 ms: the form shows as soon as Android has written the call (up to 8 s once it ended).
    for (let i = 0; !row && i < (call.ended ? 32 : 8); i++) {
      row = await Dialer.lastOutgoingCall(call.since);
      if (!row) await sleep(250);
    }
    if (!row && !call.ended) { call.finishing = false; return; } // still on the call
    const seconds = row ? row.durationSec : 0;
    set({ talkSeconds: seconds, values: startValues(S().form, seconds > 0 ? 'Yes' : 'No'), phase: seconds > 0 ? 'outcome' : 'reason' });
  }

  // Android's call state while the dialer placed a call.
  function onCallState(state) {
    const { call, phase } = S();
    if (!call || phase !== 'calling') return;
    if (state === 'OFFHOOK') call.sawOffhook = true;
    if (state === 'IDLE' && call.sawOffhook) finishCall(true);
  }

  // The business SIM from Settings (null: the phone's default), so calls on the personal SIM are left alone.
  function listenIncoming() {
    const { simId } = loadPrefs();
    try { Dialer.startIncomingListener(simId ?? null); } catch {}
  }

  // Which of this person's leads a number is: { lead, calledBack } or null.
  const identify = (number) => (number
    ? api('/api/lead/identify', { method: 'POST', body: { phone: number } }).then((r) => (r.lead ? r : null)).catch(() => null)
    : Promise.resolve(null));

  // A call ringing in on the business SIM: named during the call if it's one of the person's leads, its form after.
  function onIncoming({ state, number, answered }) {
    if (state === 'RINGING') {
      if (S().phase === 'countdown') pause(); // never dial while a call rings in
      const ring = { since: now() - 2000 };
      ring.lookup = flush().then(() => identify(number)).then((found) => {
        if (S().incoming === ring && found) set({ incomingLead: found.lead });
        // "Open leads on my laptop": a lead calling in opens while it still rings, like an outgoing call does.
        if (found && loadPrefs().autoLaptop) {
          api(`/api/lead/${encodeURIComponent(found.lead.prospectId)}/open-on-laptop`, { method: 'POST' }).catch(() => {});
        }
        return found;
      });
      set({ incoming: ring });
    }
    if (state === 'IDLE') {
      const ring = S().incoming;
      set({ incoming: null, incomingLead: null });
      if (ring && answered) incomingEnded(ring);
    }
  }

  // An answered incoming call ended: its duration from the call log, then the lead's form.
  async function incomingEnded(ring) {
    let row = null;
    for (let i = 0; !row && i < 32; i++) {
      row = await Dialer.lastIncomingCall(ring.since);
      if (!row) await sleep(250);
    }
    const found = (await ring.lookup) || (row && (await identify(row.number)));
    if (row) markIncomingHandled(row.date);
    if (found && row?.durationSec) openIncoming({ ...found, seconds: row.durationSec, at: row.date });
  }

  // The app was frozen or closed while a lead's call was answered: on open, the newest answered incoming call today
  // on the business SIM that hasn't been handled yet.
  async function catchUpIncoming() {
    if (S().incoming) return; // a call is ringing or going on; it's handled when it ends
    const today = new Date(now()); today.setHours(0, 0, 0, 0);
    let handled = 0;
    try { handled = Number(localStorage.getItem('incoming-handled')) || 0; } catch {}
    const row = await Dialer.lastIncomingCall(Math.max(handled + 1, today.getTime(), now() - 12 * 3600000)).catch(() => null);
    if (!row?.durationSec) return;
    const { simId } = loadPrefs();
    // Phones whose call log names the SIM differently (not a number) aren't filtered.
    if (simId != null && /^\d+$/.test(row.account) && Number(row.account) !== simId) return;
    markIncomingHandled(row.date);
    const found = await identify(row.number);
    if (found) openIncoming({ ...found, seconds: row.durationSec, at: row.date });
  }
  const markIncomingHandled = (date) => { try { localStorage.setItem('incoming-handled', String(date)); } catch {} };

  // Open that lead's form: switch its own reason screen to connected, open now when the dialer is free,
  // or keep it until the call being marked is saved.
  function openIncoming(item, returnTo) {
    const title = item.calledBack ? 'Called you back' : 'Called you';
    const { phase, call, form } = S();
    if (phase === 'reason' && call?.lead.prospectId === item.lead.prospectId) {
      call.startedAt = new Date(item.at).toISOString();
      set({ callback: title, talkSeconds: item.seconds, values: startValues(form, 'Yes'), phase: 'outcome' });
      return;
    }
    if (!returnTo && (!form || !['idle', 'done', 'paused'].includes(phase))) { set({ pendingIncoming: item }); return; }
    const l = { ...item.lead, ruleId: null };
    set({
      call: { lead: l, startedAt: new Date(item.at).toISOString(), returnTo: returnTo || phase },
      lead: l, leadOpen: false, callback: title, talkSeconds: item.seconds, values: startValues(form, 'Yes'), phase: 'outcome',
    });
  }

  // Back in the app: a call still marked as going may have ended while Android held this app.
  function onAppActive() {
    if (S().phase === 'calling') finishCall(!Dialer.isInCall()); // some phones never report the end (iQOO 2026-11-14)
    catchUpIncoming();
    flush();
  }

  function closePrefs() {
    if (S().prefsOpen === 'chooseSim') set({ held: false }); // the countdown is at 0, so this dials
    set({ prefsOpen: null });
    listenIncoming(); // the business SIM may have changed
  }

  // "Open on laptop" button: this lead in LSQ on the person's laptop, through the Chrome extension signed in as them.
  async function openOnLaptop() {
    const { lead } = S();
    if (!lead) return;
    try {
      await api(`/api/lead/${encodeURIComponent(lead.prospectId)}/open-on-laptop`, { method: 'POST' });
      showToast('Sent to your laptop');
    } catch (e) {
      setError(`Couldn't send to your laptop: ${e.message}`);
    }
  }

  // Instant: the save goes into the phone's outbox and is sent in the background, retried until the backend takes it,
  // so the next lead never waits on LeadSquared. Problems show through onOutboxProblem.
  function save(outcome, seconds, activity) {
    const call = S().call;
    const { lead: l, startedAt } = call;
    set({ call: null });
    enqueue({ prospectId: l.prospectId, phone: l.phone, outcome, talkSeconds: seconds, startedAt, ruleId: l.ruleId, activity });
    if (outcome !== 'skipped') S().markHandled(l.prospectId); // a skipped lead stays in the queue, at the back
    pending();
    return true;
  }

  // Send the marked activity, remember the sticky fields for the next call, move on.
  async function submit(vals) {
    if (S().saving) return;
    const { form, call, talkSeconds, lead } = S();
    const returnTo = call?.returnTo; // a callback goes back to where the counsellor was
    set({ saving: true });
    const connected = vals[form.connected?.schema] !== 'No';
    save(connected ? 'connected' : 'no_answer', talkSeconds, vals);
    rememberSticky(form, vals);
    showToast(`${form.name} saved for ${lead?.name || 'lead'}`);
    await sleep(1000); // a moment to see it saved before the next lead comes up; Save stays disabled meanwhile
    set({ saving: false, callback: null });
    if (returnTo && returnTo !== 'next') set({ lead: null, phase: returnTo }); else next();
  }

  // Instant: the next lead comes up at once; the skip is saved in the background.
  function skip() {
    const { phase, lead } = S();
    if (phase !== 'countdown' || !lead) return;
    set({ call: { lead, startedAt: new Date(now()).toISOString() } });
    S().markSkipped(lead.prospectId, now()); // back of the queue, not gone
    save('skipped', null);
    // Only skipped leads left: stop here rather than dial the one just skipped. Resume calls them, earliest skip first.
    const left = pending();
    if (!left.length || S().skipped[left[0].prospectId] != null) {
      set({ paused: true, lead: null, phase: 'paused' });
      showToast('Only skipped leads left. Resume to call them.');
      return;
    }
    showToast(`Skipped ${lead.name || 'lead'}`);
    next();
  }

  // Start / Resume: a full reload, so anything handled offline or pushed meanwhile is current.
  const start = () => { set({ paused: false }); S().resetHandled(); return next(true); };
  const pause = () => { set({ paused: true }); if (S().phase === 'countdown') setPhase('paused'); };
  const stop = () => set({ paused: true, lead: null, phase: 'idle' });

  return {
    pending, loadQueue, loadViews, prefetchViews, loadShown, pickView, loadForm, refreshNow, refresh, next, dial,
    finishCall, onCallState, onIncoming, onAppActive, listenIncoming, catchUpIncoming, openIncoming, closePrefs,
    openOnLaptop, save, submit, skip, start, pause, stop, showToast, setError,
  };
}

// A phone number the system dialer takes: digits and a leading +.
export const dialable = (phone) => String(phone || '').replace(/[^\d+]/g, '');
