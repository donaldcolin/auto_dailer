import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, Easing, Image, LayoutAnimation, Modal, StatusBar, PermissionsAndroid, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import ActivityForm from './ActivityForm';
import SettingsScreen from './SettingsScreen';
import RecordingsScreen from './RecordingsScreen';
import SetupScreen from './SetupScreen';
import Dialer from './modules/dialer';
import { api, OFFLINE } from './lib/api';
import { cached, remember } from './lib/cache';
import { enqueue, flush, onOutboxProblem, waitingLeads } from './lib/outbox';
import { loadPrefs, savePrefs } from './lib/prefs';
import { syncRecordings, syncRecordingsSoon } from './lib/recordings';
import { supabase } from './lib/supabase';
import { Btn, card, colors, Skeleton, Toast, wordmark } from './ui';

const PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
];
const COUNTDOWN_SEC = 5;
// Activity Type, Function and Role carry over from this person's last saved activity (team defaults on day one).
const stickyKey = (form) => `activity-sticky-${form.event}`;
function startValues(form, connected) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(stickyKey(form)) || '{}'); } catch {}
  return { ...form.defaults, ...saved, [form.connected?.schema]: connected };
}
function rememberSticky(form, vals) {
  const keep = Object.fromEntries(form.sticky.filter((s) => vals[s]).map((s) => [s, vals[s]]));
  try { localStorage.setItem(stickyKey(form), JSON.stringify(keep)); } catch {}
}

// Source, location, past calls… from LSQ, as label/value rows (only the filled ones arrive).
function LeadDetails({ details, compact }) {
  if (!details?.length) return null;
  return (
    <View style={compact ? styles.detailsCompact : styles.details}>
      {details.map((d) => (
        <View key={d.label} style={styles.detailRow}>
          <Text style={[styles.detailLabel, compact && styles.detailSmall]}>{d.label}</Text>
          <Text style={[styles.detailValue, compact && styles.detailSmall]} numberOfLines={2}>{d.value}</Text>
        </View>
      ))}
    </View>
  );
}

// The lead's latest LSQ activities: earlier HR Activities with what was marked, calls, pushes…
function LeadHistory({ history, compact }) {
  if (!history) return null;
  const items = compact ? (history.items || []).slice(0, 2) : history.items || [];
  return (
    <View style={compact ? styles.detailsCompact : styles.history}>
      {!compact && <Text style={styles.historyTitle}>Recent activity</Text>}
      {history.failed && <Text style={styles.historySub}>Couldn't load past activity.</Text>}
      {!history.failed && !history.items && <Skeleton style={{ height: 14, width: '70%', marginVertical: 6 }} />}
      {history.items && !history.items.length && <Text style={styles.historySub}>No earlier activity.</Text>}
      {items.map((h, i) => {
        // One line per call: spoke (with how long), didn't connect (why), or something else that happened.
        const icon = { spoke: 'call', missed: 'call-outline' }[h.kind] || 'ellipse-outline';
        const tint = h.kind === 'missed' ? colors.muted : colors.text;
        return (
          <View key={i} style={[styles.historyRow, compact && { paddingVertical: 2 }, i === items.length - 1 && { borderBottomWidth: 0 }]}>
            <View style={styles.historyHead}>
              {!compact && <Ionicons name={icon} size={16} color={tint} style={styles.historyIcon} />}
              <Text style={[styles.historyWhat, compact && styles.detailSmall]} numberOfLines={1}>{h.what}</Text>
              <Text style={[styles.historyAt, compact && styles.detailSmall]}>{h.at}</Text>
            </View>
            {!!h.detail && <Text style={[styles.historySub, !compact && styles.historyIndent, compact && styles.detailSmall]} numberOfLines={compact ? 1 : 2}>{h.detail}</Text>}
            {!!h.note && !compact && <Text style={[styles.historyNote, styles.historyIndent]} numberOfLines={3}>{h.note}</Text>}
          </View>
        );
      })}
    </View>
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dialable = (phone) => String(phone).replace(/[^\d+]/g, ''); // LSQ stores "+91-98…"
// "+91-8431772316" → "+91 84317 72316"
const pretty = (phone) => dialable(phone).replace(/^(\+91)?(\d{5})(\d{5})$/, (_, cc, a, b) => `${cc ? cc + ' ' : ''}${a} ${b}`);

/**
 * Progressive dialer: one lead at a time from /api/queue.
 * idle → countdown → calling → (0 s: reason | >0 s: outcome) → next lead.
 * The caller always marks their team's LSQ activity: one tap on a reason, or the form after a connected call.
 * Every lead dialed or skipped is saved, so the next /api/queue no longer returns it.
 */
export default function DialerScreen({ me }) {
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(null); // null | 'menu' | 'chooseSim' (first call on a dual-SIM phone)
  const simAskedRef = useRef(false);
  const [keyOpen, setKeyOpen] = useState(false); // update-your-key screen, on top so a marked activity isn't lost
  const [granted, setGranted] = useState(false);
  const [canFront, setCanFront] = useState(true);
  const [filesAccess, setFilesAccess] = useState(true); // call recordings are copied for Callyzer only with it
  const [phase, setPhaseState] = useState('idle'); // idle | loading | countdown | calling | outcome | paused | done
  const [lead, setLead] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null); // { count, source, rule, leads }
  const [views, setViews] = useState(() => cached(`views-${me.email}`)); // [{ id, name }]: My leads + the Smart View tabs ("Dialer – …" Lists)
  const [view, setViewState] = useState(loadPrefs().view || 'own');
  const viewRef = useRef(view);
  const [tab, setTab] = useState(null); // 'pushed' | 'mine'; null = pushed when there are any
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC);
  // Finger on the lead screen: the countdown waits, and carries on when it lifts.
  const [held, setHeld] = useState(false);
  const draggingRef = useRef(false);
  const countdownBar = useRef(new Animated.Value(1)).current;
  const [leadOpen, setLeadOpen] = useState(false); // marking: the form gets the room unless the caller opens the lead
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [callback, setCallback] = useState(null); // marking a lead who called in: 'Called you' | 'Called you back'
  const [incomingLead, setIncomingLead] = useState(null); // the lead on an incoming call, named while it lasts
  const [toast, setToast] = useState(null); // "HR Activity saved for Akhila", shown for a moment after each save
  const toastTimer = useRef(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // the team's LSQ activity, or null
  // Dialing waits for this: an HR phone that dialed without its form would save calls with no HR Activity.
  const [formState, setFormState] = useState('loading'); // loading | ready | failed
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingReason, setSavingReason] = useState(null);
  // Recent LSQ activity by lead id: { items } | { failed } | {} while loading. The next lead's is loaded early.
  const [histories, setHistories] = useState({});
  const historyAsked = useRef(new Set()); // the reason row just tapped, shown as "Saving…"

  // Event handlers outlive renders, so the loop's state lives in refs.
  const phaseRef = useRef('idle');
  const pausedRef = useRef(false);
  const callRef = useRef(null); // { lead, ruleId, since, startedAt, sawOffhook, finishing }
  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };
  const formRef = useRef(null);
  const queueRef = useRef({ leads: [], rule: null, source: null });
  const handledRef = useRef(new Set()); // prospect ids saved or skipped since the last Start
  const incomingRef = useRef(null); // { since, lookup }: a call ringing in on the business SIM
  const pendingIncomingRef = useRef(null); // a lead's answered call that waits for the counsellor to finish marking
  formRef.current = form;

  useEffect(() => {
    loadForm();
    // The last queue shows at once (leads already called are filtered by the server's reload and the outbox).
    const lastQueue = cached(`queue-${me.email}-${viewRef.current}`);
    loadViews();
    if (lastQueue) { queueRef.current = lastQueue; pending(); }
    PermissionsAndroid.requestMultiple(PERMISSIONS).then((res) => {
      const ok = PERMISSIONS.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
      setGranted(ok);
      if (ok) { Dialer.startCallStateListener(); listenIncoming(); }
    });
    loadQueue().catch((e) => setError(e.message));

    // A call ringing in on the business SIM: named during the call if it's one of the person's leads, its form after.
    const inSub = Dialer.addListener('onIncoming', ({ state, number, answered }) => {
      if (state === 'RINGING') {
        if (phaseRef.current === 'countdown') pause(); // never dial while a call rings in
        const ring = { since: Date.now() - 2000 };
        ring.lookup = flush().then(() => identify(number)).then((found) => {
          if (incomingRef.current === ring && found) setIncomingLead(found.lead);
          return found;
        });
        incomingRef.current = ring;
      }
      if (state === 'IDLE') {
        const ring = incomingRef.current;
        incomingRef.current = null;
        setIncomingLead(null);
        if (ring && answered) incomingEnded(ring);
      }
    });
    const callSub = Dialer.addListener('onCallState', ({ state }) => {
      if (state === 'IDLE') syncRecordingsSoon(); // any call that just ended: its recording goes to Callyzer's folder
      const call = callRef.current;
      if (!call || phaseRef.current !== 'calling') return;
      if (state === 'OFFHOOK') call.sawOffhook = true;
      if (state === 'IDLE' && call.sawOffhook) finishCall(true);
    });
    // Android may hold our JS while the call screen is on top; back in front, check the call log too.
    setCanFront(Dialer.canBringToFront());
    setFilesAccess(Dialer.hasAllFilesAccess());
    const appSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      setCanFront(Dialer.canBringToFront()); // re-check after returning from Settings
      // No call going on any more (some phones never report the end, iQOO 2026-11-14): finish it now.
      if (phaseRef.current === 'calling') finishCall(!Dialer.isInCall());
      catchUpIncoming();
      setFilesAccess(Dialer.hasAllFilesAccess());
      syncRecordings();
      flush();
    });
    syncRecordings();
    // Saves go out in the background; a problem shows here, and clears once they're all sent.
    let shown = null;
    onOutboxProblem((msg, code) => {
      if (msg) { shown = msg; setError(msg); } else setError((e) => (e === shown ? null : e));
      if (code === 'lsq_key_rejected') setKeyOpen(true);
    });
    flush();
    catchUpIncoming();
    const retry = setInterval(flush, 30000);
    return () => {
      clearInterval(retry);
      inSub.remove();
      callSub.remove();
      appSub.remove();
      Dialer.stopCallStateListener();
    };
  }, []);

  // A scroll takes over the touch and sends touchCancel with the finger still down, so a drag releases on its own end.
  const dragStart = () => { draggingRef.current = true; setHeld(true); };
  const dragEnd = () => { draggingRef.current = false; setHeld(false); };
  const touchCancel = () => { if (!draggingRef.current) setHeld(false); };

  // Countdown before each dial; Skip / Pause / Stop leave the 'countdown' phase and so cancel it.
  useEffect(() => {
    if (phase !== 'countdown' || held) return;
    if (countdown === 0) { dial(); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    // The timer decides when to dial; the bar only glides along with it, and frozen frames can't delay a call.
    const glide = Animated.timing(countdownBar, { toValue: (countdown - 1) / COUNTDOWN_SEC, duration: 1000, easing: Easing.linear, useNativeDriver: true });
    glide.start();
    return () => { clearTimeout(t); glide.stop(); };
  }, [phase, countdown, held]);

  // Load the current lead's activity, and the next lead's in the background, so it's ready when that lead comes up.
  function loadHistory(id) {
    if (!id || historyAsked.current.has(id)) return;
    historyAsked.current.add(id);
    api(`/api/lead/${encodeURIComponent(id)}/history`)
      .then((r) => setHistories((h) => ({ ...h, [id]: { items: r.history } })))
      .catch(() => { historyAsked.current.delete(id); setHistories((h) => ({ ...h, [id]: { failed: true } })); });
  }
  useEffect(() => {
    const id = lead?.prospectId;
    if (!id) return;
    loadHistory(id);
    loadHistory(queueRef.current.leads.find((l) => l.prospectId !== id && !handledRef.current.has(l.prospectId))?.prospectId);
  }, [lead?.prospectId]);

  // Foreground service while the loop runs, so Android doesn't freeze or kill it between calls.
  const looping = !['idle', 'done', 'paused'].includes(phase);
  useEffect(() => {
    Dialer.startKeepAlive(!looping); // light while stopped, so a lead calling in still opens its form
  }, [looping]);
  useEffect(() => () => Dialer.stopKeepAlive(), []);

  // While not dialing, keep the list fresh so a TL's push shows up. Never starts dialing by itself.
  useEffect(() => {
    if (phase !== 'idle' && phase !== 'done') return;
    const t = setInterval(() => refresh().catch(() => {}), 30000);
    return () => clearInterval(t);
  }, [phase]);

  // The last form opens at once; the server's copy replaces it when it arrives.
  function loadForm() {
    const last = cached(`form-${me.email}-${me.mode}`);
    if (last) { setForm(last); setFormState('ready'); } else setFormState('loading');
    api('/api/activity-form')
      .then((r) => { setForm(r.form); setFormState(r.form ? 'ready' : 'failed'); if (r.form) remember(`form-${me.email}-${me.mode}`, r.form); })
      .catch(() => { if (!last) setFormState('failed'); });
  }

  // The queue as last loaded, minus the leads handled since. Moving to the next lead uses this list
  // straight away; the server reload runs in the background (it only adds a TL's new pushes).
  function pending() {
    const { leads, rule, source } = queueRef.current;
    const waiting = waitingLeads(); // saved on the phone, not yet on the server
    const left = leads.filter((l) => !handledRef.current.has(l.prospectId) && !waiting.has(l.prospectId));
    setQueueInfo({ count: left.length, source, rule, leads: left });
    return left;
  }

  // skipCache: re-read LSQ on the server too (menu → Refresh leads), so a TL's new leads show at once.
  async function loadQueue(skipCache = false) {
    const v = viewRef.current;
    const q = await api(`/api/queue?view=${encodeURIComponent(v)}${skipCache ? '&fresh=1' : ''}`);
    if (v !== viewRef.current) return pending(); // the person switched tabs while this loaded
    // The tab's List was renamed or deleted: back to My leads.
    if (v !== 'own' && q.source === 'own') { pickView('own', false); showToast('That view is gone; showing My leads'); }
    queueRef.current = { leads: q.leads, rule: q.rule, source: q.source };
    remember(`queue-${me.email}-${viewRef.current}`, queueRef.current);
    return pending();
  }

  const loadViews = () => api('/api/queue/views').then((r) => { setViews(r.views); remember(`views-${me.email}`, r.views); }).catch(() => {});

  // A Smart View tab, like in LSQ: remembered on the phone, its leads loaded at once.
  function pickView(id, reload = true) {
    viewRef.current = id;
    setViewState(id);
    savePrefs({ view: id });
    if (!reload) return;
    const last = cached(`queue-${me.email}-${id}`);
    queueRef.current = last || { leads: [], rule: null, source: null };
    if (last) pending(); else setQueueInfo(null);
    loadQueue().catch((e) => setError(e.message));
  }

  async function refreshNow() {
    setMenuOpen(false);
    setRefreshing(true);
    try {
      loadViews();
      const left = await loadQueue(true);
      setError(null);
      if (left.length && phaseRef.current === 'done') setPhase('idle');
      showToast(`Leads refreshed: ${left.length} to call`);
    } catch (e) {
      setError(`Could not refresh: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  function confirmSignOut() {
    setMenuOpen(false);
    Alert.alert('Sign out?', 'You can sign in again with Google.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() },
    ]);
  }

  const markHandled = (prospectId) => { handledRef.current.add(prospectId); pending(); };

  // Reload the list only; dialing always waits for Start.
  async function refresh() {
    const left = await loadQueue();
    setError((e) => (e?.includes(OFFLINE) ? null : e)); // back online
    if (left.length && phaseRef.current === 'done') setPhase('idle');
  }

  async function next(fresh = false) {
    const waiting = pendingIncomingRef.current; // a lead's call answered while another was being marked: that form first
    if (waiting) { pendingIncomingRef.current = null; openIncoming(waiting, 'next'); return; }
    if (pausedRef.current) { setPhase('paused'); return; }
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
    if (!left.length) { setLead(null); setPhase('done'); return; }
    setCallback(null);
    setLead({ ...left[0], ruleId: queueRef.current.rule?.id || null });
    setCountdown(COUNTDOWN_SEC);
    setHeld(false);
    setLeadOpen(false);
    countdownBar.setValue(1);
    setPhase('countdown');
  }

  function dial() {
    const prefs = loadPrefs();
    let sims = [];
    try { sims = Dialer.listSims(); } catch {}
    // Dual SIM and none chosen: ask once, holding the countdown; closing Settings dials.
    if (sims.length > 1 && !sims.some((s) => s.id === prefs.simId) && !simAskedRef.current) {
      simAskedRef.current = true;
      setHeld(true);
      setPrefsOpen('chooseSim');
      return;
    }
    callRef.current = { lead, since: Date.now() - 2000, startedAt: new Date().toISOString(), sawOffhook: false, finishing: false };
    setPhase('calling');
    try {
      Dialer.placeCall(dialable(lead.phone), sims.some((s) => s.id === prefs.simId) ? prefs.simId : null);
      if (prefs.autoLaptop) api(`/api/lead/${encodeURIComponent(lead.prospectId)}/open-on-laptop`, { method: 'POST' }).catch(() => {});
    } catch (e) {
      setError(`Could not place the call: ${e.message}`);
      callRef.current = null;
      setPhase('idle');
    }
  }

  // The call log is the source of truth: no row yet means the call is still going.
  // `ended` is set by the IDLE event (or the "Call ended" button) even while a check from
  // AppState is already running, so that check keeps waiting for the row instead of giving up.
  async function finishCall(ended) {
    const call = callRef.current;
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
    setTalkSeconds(seconds);

    setValues(startValues(formRef.current, seconds > 0 ? 'Yes' : 'No'));
    setPhase(seconds > 0 ? 'outcome' : 'reason');
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
    if (incomingRef.current) return; // a call is ringing or going on; it's handled when it ends
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let handled = 0;
    try { handled = Number(localStorage.getItem('incoming-handled')) || 0; } catch {}
    const row = await Dialer.lastIncomingCall(Math.max(handled + 1, today.getTime(), Date.now() - 12 * 3600000)).catch(() => null);
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
    const phase = phaseRef.current;
    if (phase === 'reason' && callRef.current?.lead.prospectId === item.lead.prospectId) {
      callRef.current.startedAt = new Date(item.at).toISOString();
      setCallback(title);
      setTalkSeconds(item.seconds);
      setValues(startValues(formRef.current, 'Yes'));
      setPhase('outcome');
      return;
    }
    if (!returnTo && (!formRef.current || !['idle', 'done', 'paused'].includes(phase))) { pendingIncomingRef.current = item; return; }
    const l = { ...item.lead, ruleId: null };
    callRef.current = { lead: l, startedAt: new Date(item.at).toISOString(), returnTo: returnTo || phase };
    setLead(l);
    setLeadOpen(false);
    setCallback(title);
    setTalkSeconds(item.seconds);
    setValues(startValues(formRef.current, 'Yes'));
    setPhase('outcome');
  }

  function closePrefs() {
    if (prefsOpen === 'chooseSim') setHeld(false); // the countdown is at 0, so this dials
    setPrefsOpen(null);
    listenIncoming(); // the business SIM may have changed
  }

  // Opens this lead in LSQ on the person's laptop, through the Chrome extension signed in as them.
  async function openOnLaptop() {
    try {
      await api(`/api/lead/${encodeURIComponent(lead.prospectId)}/open-on-laptop`, { method: 'POST' });
      showToast('Sent to your laptop');
    } catch (e) {
      setError(`Couldn't send to your laptop: ${e.message}`);
    }
  }

  // Instant: the save goes into the phone's outbox and is sent in the background, retried until the backend takes it,
  // so the next lead never waits on LeadSquared. Problems show through onOutboxProblem.
  async function save(outcome, seconds, activity) {
    const call = callRef.current;
    const { lead: l, startedAt } = call;
    if (callRef.current === call) callRef.current = null;
    markHandled(l.prospectId);
    enqueue({ prospectId: l.prospectId, phone: l.phone, outcome, talkSeconds: seconds, startedAt, ruleId: l.ruleId, activity });
    return true;
  }

  // Send the marked activity, remember the sticky fields for the next call, move on.
  async function submit(vals) {
    if (saving) return;
    const returnTo = callRef.current?.returnTo; // a callback goes back to where the counsellor was
    setSaving(true);
    const connected = vals[form.connected?.schema] !== 'No';
    const ok = await save(connected ? 'connected' : 'no_answer', talkSeconds, vals);
    if (!ok) { setSaving(false); return; }
    rememberSticky(form, vals);
    showToast(`${form.name} saved for ${lead.name || 'lead'}`);
    await sleep(1000); // a moment to see it saved before the next lead comes up; Save stays disabled meanwhile
    setSaving(false);
    setCallback(null);
    if (returnTo && returnTo !== 'next') { setLead(null); setPhase(returnTo); } else next();
  }

  // Instant: the next lead comes up at once (waiting on the save let the countdown run on, and the buttons shift
  // under a second tap); the skip is saved in the background.
  function skip() {
    if (phaseRef.current !== 'countdown') return;
    callRef.current = { lead, startedAt: new Date().toISOString() };
    markHandled(lead.prospectId);
    save('skipped', null);
    showToast(`Skipped ${lead.name || 'lead'}`);
    next();
  }

  function showToast(text) {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  // Start / Resume: a full reload, so anything handled offline or pushed meanwhile is current.
  const start = () => { pausedRef.current = false; handledRef.current = new Set(); next(true); };
  const pause = () => { pausedRef.current = true; if (phaseRef.current === 'countdown') setPhase('paused'); };
  const stop = () => { pausedRef.current = true; setLead(null); setPhase('idle'); };

  const active = phase === 'loading' || (['countdown', 'calling', 'outcome', 'reason'].includes(phase) && lead);
  const marking = phase === 'outcome' || phase === 'reason'; // after a call: lead card on top, what to mark below
  const reasons = form?.connected ? form.fields.find((f) => f.schema === form.connected.reason).dependent.No : [];
  const left = queueInfo?.count ?? 0;
  const pushedLeads = (queueInfo?.leads || []).filter((l) => l.pushed);
  const myLeads = (queueInfo?.leads || []).filter((l) => !l.pushed);
  // A Smart View chip picked: the list is that view, so the Pushed / Your leads switch goes away until "All".
  const inView = !!view && view !== 'own' && !!queueInfo && !queueInfo.rule;
  const shownTab = inView ? 'mine' : tab || (pushedLeads.length ? 'pushed' : 'mine');
  const tabLeads = shownTab === 'pushed' ? pushedLeads : myLeads;
  const showViews = views?.length > 1 && !!queueInfo && !queueInfo.rule && (shownTab === 'mine' || !left || phase === 'done');
  const status = {
    countdown: held ? 'Paused' : `Calling in ${countdown}`,
    calling: 'On call',
    outcome: callback ? `${callback}, ${talkSeconds} s` : talkSeconds ? `Connected, ${talkSeconds} s` : 'Not connected',
    reason: 'Not answered',
    loading: 'Next lead',
  }[phase];

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Image source={wordmark} style={styles.wordmark} accessibilityLabel="Kalvium" />
        {refreshing ? (
          <ActivityIndicator color={colors.text} accessibilityLabel="Refreshing leads" style={styles.iconBtn} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Menu"
            hitSlop={12}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.4 }]}
            onPress={() => setMenuOpen(true)}
          >
            <Ionicons name="menu" size={26} color={colors.text} />
          </Pressable>
        )}
      </View>

      <Modal visible={keyOpen} animationType="slide" onRequestClose={() => setKeyOpen(false)}>
        <SetupScreen
          me={me}
          keysOnly
          onCancel={() => setKeyOpen(false)}
          onDone={() => { setKeyOpen(false); setError(null); showToast('LeadSquared key updated'); flush(); }}
        />
      </Modal>

      <Modal visible={!!prefsOpen} animationType="slide" onRequestClose={closePrefs}>
        <SettingsScreen
          chooseSim={prefsOpen === 'chooseSim'}
          onClose={closePrefs}
          onRecordings={() => { closePrefs(); setRecordingsOpen(true); }}
          onKey={() => { closePrefs(); setKeyOpen(true); }}
        />
      </Modal>

      <Modal visible={recordingsOpen} animationType="slide" onRequestClose={() => setRecordingsOpen(false)}>
        <RecordingsScreen onClose={() => setRecordingsOpen(false)} />
      </Modal>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuScrim} onPress={() => setMenuOpen(false)} accessibilityLabel="Close menu">
          <View style={styles.menu}>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
              onPress={refreshNow}
            >
              <Ionicons name="refresh" size={20} color={colors.text} />
              <Text style={styles.menuText}>Refresh leads</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
              onPress={() => { setMenuOpen(false); setPrefsOpen('menu'); }}
            >
              <Ionicons name="settings-outline" size={20} color={colors.text} />
              <Text style={styles.menuText}>Settings</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: looping }}
              disabled={looping}
              style={({ pressed }) => [styles.menuItem, styles.lastRow, (pressed || looping) && styles.pressed]}
              onPress={confirmSignOut}
            >
              <Ionicons name="log-out-outline" size={20} color={looping ? colors.muted : colors.text} />
              <Text style={[styles.menuText, looping && { color: colors.muted }]}>
                {looping ? 'Sign out (pause first)' : 'Sign out'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {active && marking ? (
        <View style={styles.mark}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: leadOpen }}
            accessibilityHint="Shows the lead's details"
            style={styles.leadCard}
            onPress={() => setLeadOpen((o) => !o)}
          >
            <View style={styles.leadHead}>
              <View style={styles.teamBody}>
                <Text style={styles.cardName} numberOfLines={1}>{lead.name || 'No name'}</Text>
                <Text style={styles.cardMeta} numberOfLines={1}>{status}, {pretty(lead.phone)}</Text>
              </View>
              <Ionicons name={leadOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.muted} />
            </View>
            {leadOpen && (
              <>
                {!!lead.stage && <Text style={[styles.cardMeta, { marginTop: 8 }]}>{lead.stage}{lead.pushed ? ', pushed by your TL' : ''}</Text>}
                <LeadDetails details={lead.details} compact />
                <LeadHistory history={histories[lead.prospectId] || {}} compact />
              </>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.laptop, pressed && styles.outcomePressed]}
            onPress={openOnLaptop}
          >
            <Ionicons name="laptop-outline" size={18} color={colors.text} />
            <Text style={styles.laptopText}>Open on laptop</Text>
          </Pressable>

          <Text style={[styles.sectionTitle, phase === 'outcome' && { marginBottom: 12 }]}>
            {phase === 'reason' ? "Why didn't it connect?" : form.name}
          </Text>
          {phase === 'reason' && <Text style={styles.sectionHint}>Tap a reason to save the {form.name}.</Text>}

          {phase === 'reason' && (
            <ScrollView style={styles.outcomes} contentContainerStyle={styles.outcomeList}>
              {reasons.map((r, i) => (
                <Pressable
                  key={r}
                  accessibilityRole="button"
                  disabled={saving}
                  style={({ pressed }) => [styles.outcome, pressed && styles.outcomePressed]}
                  onPress={async () => {
                    setSavingReason(r);
                    await submit({ ...values, [form.connected.reason]: r });
                    setSavingReason(null);
                  }}
                >
                  <Text style={styles.outcomeText}>{r}</Text>
                  {savingReason === r && <Text style={styles.muted}>Saving…</Text>}
                </Pressable>
              ))}
            </ScrollView>
          )}
          {phase === 'reason' && (
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.outcome, styles.fullForm, pressed && styles.outcomePressed]}
              onPress={() => setPhase('outcome')}
            >
              <Text style={styles.outcomeText}>Fill the full form instead</Text>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>
          )}

          {phase === 'outcome' && (
            <View style={styles.formBox}>
              <ActivityForm form={form} values={values} onChange={setValues} />
            </View>
          )}
        </View>
      ) : phase === 'loading' ? (
        <View style={styles.call} accessibilityLabel="Loading the next lead">
          <Skeleton style={{ width: 90, height: 16, marginBottom: 16 }} />
          <Skeleton style={{ width: '70%', height: 34, marginBottom: 12 }} />
          <Skeleton style={{ width: 150, height: 18, marginBottom: 8 }} />
          <Skeleton style={{ width: 110, height: 18 }} />
        </View>
      ) : active ? (
        <View style={styles.formBox} onTouchStart={() => setHeld(true)} onTouchEnd={() => setHeld(false)} onTouchCancel={touchCancel}>
          {/* Stays pinned while the lead scrolls: when the call happens is what matters most here. */}
          {phase === 'countdown' && (
            <View style={styles.barTrack}>
              <Animated.View style={[styles.barFill, { transform: [{ scaleX: countdownBar }] }]} />
            </View>
          )}
          <View style={styles.banner} accessibilityLiveRegion="polite">
            {phase === 'calling' && <View style={styles.liveDot} />}
            <Text style={styles.bannerText}>{status}</Text>
            {phase === 'countdown' && <Text style={styles.bannerHint}>{held ? 'Lift to continue' : 'Hold the screen to pause'}</Text>}
          </View>
          <ScrollView
            key={lead.prospectId} // a fresh screen per lead: starts at the top, no scroll carried over
            contentContainerStyle={styles.call}
            onScrollBeginDrag={dragStart}
            onScrollEndDrag={dragEnd}
          >
            <Text style={styles.callName}>{lead.name || 'No name'}</Text>
            <Text style={styles.callPhone}>{pretty(lead.phone)}</Text>
            <View style={styles.tags}>
              {!!lead.stage && <Text style={styles.tag}>{lead.stage}</Text>}
              {lead.pushed && <Text style={[styles.tag, styles.tagOn]}>Pushed by your TL</Text>}
            </View>
            <LeadDetails details={lead.details} />
            <LeadHistory history={histories[lead.prospectId] || {}} />
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {!granted && <Text style={styles.notice}>Allow calls, phone state and call log to start dialing.</Text>}
          {formState === 'failed' && (
            <Text style={styles.notice}>
              Couldn't load your call form, so dialing is off.{' '}
              <Text style={styles.noticeLink} onPress={loadForm}>Try again</Text>
            </Text>
          )}
          {!filesAccess && (
            <Text style={styles.notice}>
              Turn on "All files access" so your call recordings reach Callyzer.{' '}
              <Text style={styles.noticeLink} onPress={() => setRecordingsOpen(true)}>Set up</Text>
            </Text>
          )}
          {!canFront && (
            <Text style={styles.notice}>
              Turn on "Display over other apps" so the dialer returns after each call.{' '}
              <Text style={styles.noticeLink} onPress={() => Dialer.openBringToFrontSettings()}>Open settings</Text>
            </Text>
          )}

          {queueInfo && !!left && phase !== 'done' && !inView && (
            // Pushed leads are called first, then your leads: one switch shows either list.
            <View style={styles.segment} accessibilityRole="tablist">
              {[['pushed', 'Pushed with LSQ', pushedLeads.length], ['mine', 'Your leads', myLeads.length]].map(([key, label, n]) => (
                <Pressable
                  key={key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: shownTab === key }}
                  style={[styles.segItem, shownTab === key && styles.segItemOn]}
                  onPress={() => setTab(key)}
                >
                  <Text style={[styles.segText, shownTab === key && styles.segTextOn]} numberOfLines={1}>{label}</Text>
                  <Text style={[styles.segCount, shownTab === key && styles.segTextOn]}>{n}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {queueInfo?.rule && <Text style={[styles.muted, { marginTop: 12 }]}>From {queueInfo.rule.listName}, since {queueInfo.rule.startTime}</Text>}

          {/* Your leads, filtered by the Smart View tabs. Pushed leads are never filtered. */}
          {showViews && (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.views} style={styles.viewsRow}>
                {views.map((v) => (
                  <Pressable
                    key={v.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: v.id === view }}
                    onPress={() => v.id !== view && pickView(v.id)}
                    style={({ pressed }) => [styles.viewChip, v.id === view && styles.viewChipOn, pressed && v.id !== view && styles.pressed]}
                  >
                    <Text style={[styles.viewText, v.id === view && styles.viewTextOn]}>{v.id === 'own' ? 'All' : v.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}

          {queueInfo ? (
            (phase === 'done' || !left) ? (
              <View style={styles.caughtUp}>
                <Text style={styles.caughtUpTitle}>All caught up</Text>
                <Text style={styles.muted}>
                  {view !== 'own' && !queueInfo.rule ? 'Nothing left in this view. Pick another above, or ' : 'No leads to call right now. '}
                  ☰ → Refresh leads checks again.
                </Text>
              </View>
            ) : (
              <>
                
              {tabLeads.slice(0, 50).map((l) => {
                const d = Object.fromEntries((l.details || []).map((x) => [x.label, x.value]));
                const calls = d.Calls?.replace(/^(\d+) made/, (_, n) => `${n} ${n === '1' ? 'call' : 'calls'}`);
                const about = [d.Source?.split(',')[0], d.Location?.split(',')[0], calls].filter(Boolean).join(', ');
                return (
                  <View key={l.prospectId} style={styles.row}>
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName} numberOfLines={1}>{l.name || 'No name'}</Text>
                      <Text style={styles.rowAbout} numberOfLines={1}>{about || l.stage}</Text>
                    </View>
                    {!!d['Lead age'] && <Text style={styles.rowAge}>{d['Lead age']}</Text>}
                  </View>
                );
              })}
              {tabLeads.length > 50 && <Text style={styles.more}>and {tabLeads.length - 50} more</Text>}
                {tabLeads.length > 50 && <Text style={styles.more}>and {tabLeads.length - 50} more</Text>}
                {!tabLeads.length && <Text style={styles.more}>None right now.</Text>}
              </>
            )
          ) : (
            <View accessibilityLabel="Loading your leads">
              <Skeleton style={{ height: 44, borderRadius: 22 }} />
              <Skeleton style={{ width: 120, height: 14, marginTop: 28, marginBottom: 8 }} />
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={styles.row}>
                  <Skeleton style={{ flex: 1, height: 18, marginRight: 48 }} />
                  <Skeleton style={{ width: 72, height: 14 }} />
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {!!incomingLead && <Text style={[styles.footnote, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>On a call with {incomingLead.name || 'a lead'}</Text>}
      {!!error && <Text style={[styles.footnote, { color: colors.red }]} numberOfLines={3}>{error}</Text>}

      <Toast text={toast} />

      <View style={styles.footer}>
        {['idle', 'done'].includes(phase) && (
          phase === 'done'
            ? <Btn title="Check again" onPress={() => refresh().catch((e) => setError(e.message))} />
            : <Btn title={formState === 'loading' ? 'Getting ready…' : 'Start'} onPress={start} disabled={!granted || !left || formState !== 'ready'} />
        )}
        {phase === 'paused' && (
          <View style={styles.pair}>
            <Btn title="Stop" kind="plain" onPress={stop} style={styles.half} />
            <Btn title="Resume" onPress={start} style={styles.half} />
          </View>
        )}
        {phase === 'countdown' && (
          <View style={styles.pair}>
            <Btn title="Back to list" kind="plain" onPress={pause} style={styles.half} />
            <Btn title="Skip" kind="plain" onPress={skip} style={styles.half} />
          </View>
        )}
        {phase === 'calling' && (
          <View style={styles.pair}>
            <Btn title="Pause after" kind="plain" onPress={pause} style={styles.half} />
            <Btn title="Call ended" kind="plain" onPress={() => finishCall(true)} style={styles.half} />
          </View>
        )}
        {phase === 'reason' && <Btn title="Pause after this" kind="plain" onPress={pause} />}
        {phase === 'outcome' && callback && <Btn title={saving ? 'Saving…' : 'Save'} onPress={() => submit(values)} disabled={saving} />}
        {phase === 'outcome' && !callback && (
          <View style={styles.pair}>
            <Btn title="Pause after" kind="plain" onPress={pause} style={styles.half} />
            <Btn title={saving ? 'Saving…' : 'Save'} onPress={() => submit(values)} disabled={saving} style={styles.half} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // The app draws under the status bar (edge to edge), so the header starts below its real height.
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: (StatusBar.currentHeight || 24) + 24, paddingBottom: 12 },
  wordmark: { width: 119, height: 24 }, // 2000×404 artwork
  iconBtn: { padding: 4, minWidth: 34 },
  menuScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)' },
  menu: { ...card, position: 'absolute', top: (StatusBar.currentHeight || 24) + 72, right: 24, minWidth: 220, elevation: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  menuText: { fontSize: 17, color: colors.text },
  muted: { color: colors.muted, fontSize: 15 },

  list: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 },
  count: { fontSize: 72, fontWeight: '300', color: colors.text, lineHeight: 80 },
  countLabel: { fontSize: 17, color: colors.text, marginBottom: 20 },
  notice: { fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 20 },
  noticeLink: { textDecorationLine: 'underline' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 17, color: colors.text },
  rowAbout: { fontSize: 13, color: colors.muted },
  rowAge: { fontSize: 13, color: colors.muted },
  caughtUp: { gap: 8, marginBottom: 24 },
  caughtUpTitle: { fontSize: 34, fontWeight: '300', color: colors.text },
  listTitle: { fontSize: 13, color: colors.muted, marginTop: 24, marginBottom: 2 },
  more: { fontSize: 15, color: colors.muted, paddingVertical: 16 },

  call: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 24 },
  barTrack: { height: 2, backgroundColor: colors.line },
  barFill: { height: 2, backgroundColor: colors.text, transformOrigin: 'left' },
  // Opaque and on top, so the lead's name scrolling up passes under it instead of showing through.
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 10, backgroundColor: colors.bg, zIndex: 1, elevation: 1 },
  bannerText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  bannerHint: { fontSize: 13, color: colors.muted },
  callPhone: { fontSize: 18, color: colors.text, fontVariant: ['tabular-nums'] },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  viewsRow: { marginHorizontal: -24, marginTop: 16, marginBottom: 4, flexGrow: 0 },
  segment: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4, borderRadius: 24, backgroundColor: '#F2F2F2' },
  segItem: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 20 },
  segItemOn: { backgroundColor: colors.bg, elevation: 1 },
  segText: { fontSize: 14, color: colors.muted },
  segCount: { fontSize: 14, color: colors.muted, fontVariant: ['tabular-nums'] },
  segTextOn: { color: colors.text, fontWeight: '600' },
  views: { gap: 8, paddingHorizontal: 24 },
  viewChip: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#F2F2F2' },
  viewChipOn: { backgroundColor: colors.text },
  viewText: { fontSize: 14, color: colors.text },
  viewTextOn: { color: colors.bg, fontWeight: '600' },
  tag: { fontSize: 13, color: colors.text, backgroundColor: '#F2F2F2', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, overflow: 'hidden' },
  tagOn: { color: colors.bg, backgroundColor: colors.text },
  history: { marginTop: 28, gap: 4 },
  historyTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
  historyRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  historyHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  historyIcon: { width: 18 },
  historyIndent: { marginLeft: 28 },
  historyNote: { fontSize: 14, lineHeight: 20, color: colors.text, fontStyle: 'italic', marginTop: 4 },
  historyWhat: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text }, // the activity's name
  historyAt: { fontSize: 13, color: colors.muted },
  historySub: { fontSize: 14, color: colors.muted, marginTop: 2 },
  mark: { flex: 1, paddingHorizontal: 24, paddingTop: 16 },
  leadCard: { ...card, backgroundColor: '#F7F7F7', paddingHorizontal: 16, paddingVertical: 12, marginBottom: 20 },
  leadHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  laptop: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8, minHeight: 44, paddingHorizontal: 16, marginTop: -8, marginBottom: 20, borderRadius: 22, borderWidth: 1.5, borderColor: colors.line },
  laptopText: { fontSize: 15, fontWeight: '500', color: colors.text },
  teamBody: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 17, fontWeight: '600', color: colors.text },
  cardMeta: { fontSize: 14, color: colors.muted, lineHeight: 20, marginTop: 1 },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: colors.text },
  sectionHint: { fontSize: 15, color: colors.muted, marginTop: 2, marginBottom: 12 },
  formBox: { flex: 1 },
  fullForm: { marginTop: 20, marginBottom: 16 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  callName: { fontSize: 30, fontWeight: '600', color: colors.text, marginBottom: 4 },
  outcomes: { flexGrow: 0 },
  outcomeList: { gap: 8 },
  // Same grey cards as the call form, so both screens after a call look alike.
  outcome: { ...card, backgroundColor: '#F7F7F7', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 56, paddingVertical: 10, paddingHorizontal: 16 },
  outcomePressed: { backgroundColor: '#EBEBEB' },
  lastRow: { borderBottomWidth: 0 },
  outcomeText: { fontSize: 15, color: colors.text },
  pressed: { backgroundColor: '#F5F5F5' },

  details: { ...card, marginTop: 20, paddingHorizontal: 16, paddingVertical: 8 },
  detailsCompact: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DADADA' },
  detailRow: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  detailLabel: { width: 84, fontSize: 15, color: colors.muted },
  detailValue: { flex: 1, fontSize: 15, color: colors.text },
  detailSmall: { fontSize: 13 },
  footnote: { paddingHorizontal: 24, paddingBottom: 8, fontSize: 14, color: colors.muted },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  pair: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
});
