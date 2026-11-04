import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Modal, StatusBar, PermissionsAndroid, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import ActivityForm from './ActivityForm';
import Dialer from './modules/dialer';
import { api } from './lib/api';
import { supabase } from './lib/supabase';
import { Btn, card, colors, Skeleton, Toast, wordmark } from './ui';

const PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
];
const COUNTDOWN_SEC = 5;
const NO_ANSWER_PAUSE_MS = 3000;
// shortcut: placeholder outcomes for teams without an LSQ activity form (sales); must match backend/routes/disposition.js.
const OUTCOMES = [
  ['interested', 'Interested'],
  ['call_back', 'Call back'],
  ['not_interested', 'Not interested'],
  ['wrong_number', 'Wrong number'],
];

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
      {items.map((h, i) => (
        <View key={i} style={[styles.historyRow, compact && { paddingVertical: 2 }]}>
          <View style={styles.historyHead}>
            <Text style={[styles.historyWhat, compact && styles.detailSmall]} numberOfLines={1}>{h.what}</Text>
            <Text style={[styles.historyAt, compact && styles.detailSmall]}>{h.at}</Text>
          </View>
          {!!(h.detail || h.note) && (
            <Text style={[styles.historySub, compact && styles.detailSmall]} numberOfLines={compact ? 1 : 3}>
              {[h.detail, h.note && `"${h.note}"`].filter(Boolean).join('. ')}
            </Text>
          )}
          {!compact && !!h.by && <Text style={styles.historyBy}>{h.by}</Text>}
        </View>
      ))}
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
 * With an LSQ activity form (HR) the caller always marks it: one tap on a reason, or the form after a connected call.
 * Without one (sales, for now) 0 s is saved as No answer by itself and connected calls get the placeholder outcomes.
 * Every lead dialed or skipped is saved, so the next /api/queue no longer returns it.
 */
export default function DialerScreen() {
  const [me, setMe] = useState(null);
  const [granted, setGranted] = useState(false);
  const [canFront, setCanFront] = useState(true);
  const [phase, setPhaseState] = useState('idle'); // idle | loading | countdown | calling | outcome | paused | done
  const [lead, setLead] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null); // { count, source, rule, leads }
  const [tab, setTab] = useState(null); // 'pushed' | 'mine'; null = pushed when there are any
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC);
  // The lead whose countdown is frozen so the caller can read it; tied to the lead so the next one never inherits it.
  const [heldId, setHeldId] = useState(null);
  const [talkSeconds, setTalkSeconds] = useState(0);
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
  formRef.current = form;

  useEffect(() => {
    api('/api/me').then(setMe).catch((e) => setError(e.message));
    loadForm();
    PermissionsAndroid.requestMultiple(PERMISSIONS).then((res) => {
      const ok = PERMISSIONS.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
      setGranted(ok);
      if (ok) Dialer.startCallStateListener();
    });
    loadQueue().catch((e) => setError(e.message));

    const callSub = Dialer.addListener('onCallState', ({ state }) => {
      const call = callRef.current;
      if (!call || phaseRef.current !== 'calling') return;
      if (state === 'OFFHOOK') call.sawOffhook = true;
      if (state === 'IDLE' && call.sawOffhook) finishCall(true);
    });
    // Android may hold our JS while the call screen is on top; back in front, check the call log too.
    setCanFront(Dialer.canBringToFront());
    const appSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      setCanFront(Dialer.canBringToFront()); // re-check after returning from Settings
      if (phaseRef.current === 'calling') finishCall(false);
    });
    return () => {
      callSub.remove();
      appSub.remove();
      Dialer.stopCallStateListener();
    };
  }, []);

  const held = !!lead && heldId === lead.prospectId;
  const hold = () => { if (phaseRef.current === 'countdown' && lead) setHeldId(lead.prospectId); };

  // Countdown before each dial; Skip / Pause / Stop leave the 'countdown' phase and so cancel it.
  useEffect(() => {
    if (phase !== 'countdown' || held) return;
    if (countdown === 0) { dial(); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
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
    if (looping) Dialer.startKeepAlive();
    else Dialer.stopKeepAlive();
  }, [looping]);
  useEffect(() => () => Dialer.stopKeepAlive(), []);

  // While not dialing, keep the list fresh so a TL's push shows up. Never starts dialing by itself.
  useEffect(() => {
    if (phase !== 'idle' && phase !== 'done') return;
    const t = setInterval(() => refresh().catch(() => {}), 30000);
    return () => clearInterval(t);
  }, [phase]);

  function loadForm() {
    setFormState('loading');
    api('/api/activity-form')
      .then((r) => { setForm(r.form); setFormState('ready'); })
      .catch(() => setFormState('failed'));
  }

  // The queue as last loaded, minus the leads handled since. Moving to the next lead uses this list
  // straight away; the server reload runs in the background (it only adds a TL's new pushes).
  function pending() {
    const { leads, rule, source } = queueRef.current;
    const left = leads.filter((l) => !handledRef.current.has(l.prospectId));
    setQueueInfo({ count: left.length, source, rule, leads: left });
    return left;
  }

  // skipCache: re-read LSQ on the server too (menu → Refresh leads), so a TL's new leads show at once.
  async function loadQueue(skipCache = false) {
    const q = await api(skipCache ? '/api/queue?fresh=1' : '/api/queue');
    queueRef.current = { leads: q.leads, rule: q.rule, source: q.source };
    return pending();
  }

  async function refreshNow() {
    setMenuOpen(false);
    setRefreshing(true);
    try {
      const left = await loadQueue(true);
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
    if (left.length && phaseRef.current === 'done') setPhase('idle');
  }

  async function next(fresh = false) {
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
    setLead({ ...left[0], ruleId: queueRef.current.rule?.id || null });
    setCountdown(COUNTDOWN_SEC);
    setPhase('countdown');
  }

  function dial() {
    callRef.current = { lead, since: Date.now() - 2000, startedAt: new Date().toISOString(), sawOffhook: false, finishing: false };
    setPhase('calling');
    try {
      Dialer.placeCall(dialable(lead.phone));
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
    for (let i = 0; !row && i < (call.ended ? 8 : 2); i++) {
      row = await Dialer.lastOutgoingCall(call.since);
      if (!row) await sleep(1000);
    }
    if (!row && !call.ended) { call.finishing = false; return; } // still on the call
    const seconds = row ? row.durationSec : 0;
    setTalkSeconds(seconds);

    if (formRef.current) {
      setValues(startValues(formRef.current, seconds > 0 ? 'Yes' : 'No'));
      setPhase(seconds > 0 ? 'outcome' : 'reason');
      return;
    }
    if (seconds > 0) {
      setPhase('outcome');
      return;
    }
    await save('no_answer', 0);
    showToast(`No answer saved for ${call.lead.name || 'lead'}`);
    await sleep(NO_ANSWER_PAUSE_MS);
    next();
  }

  // Returns false when not saved; the call stays open so a marked activity can be sent again.
  async function save(outcome, seconds, activity) {
    const call = callRef.current;
    const { lead: l, startedAt } = call;
    // Only clear the call this save was for: a skip saves in the background while the next lead is already up.
    const done = () => { if (callRef.current === call) callRef.current = null; markHandled(l.prospectId); };
    try {
      await api('/api/disposition', {
        method: 'POST',
        body: { prospectId: l.prospectId, phone: l.phone, outcome, talkSeconds: seconds, startedAt, ruleId: l.ruleId, activity },
      });
      done();
      setError(null);
      return true;
    } catch (e) {
      // shortcut: a failed save is shown, not retried; step 6 adds an offline outbox.
      setError(`Not saved: ${e.message}`);
      // Without an activity form the loop moves on; the lead comes back on the next full load.
      if (!activity) done();
      return false;
    }
  }

  // Send the marked activity, remember the sticky fields for the next call, move on.
  async function submit(vals) {
    if (saving) return;
    setSaving(true);
    const connected = vals[form.connected?.schema] !== 'No';
    const ok = await save(connected ? 'connected' : 'no_answer', talkSeconds, vals);
    setSaving(false);
    if (!ok) return;
    rememberSticky(form, vals);
    showToast(`${form.name} saved for ${lead.name || 'lead'}`);
    next();
  }

  async function chooseOutcome(outcome, label) {
    await save(outcome, talkSeconds);
    showToast(`${label} saved for ${lead.name || 'lead'}`);
    next();
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
  const shownTab = tab || (pushedLeads.length ? 'pushed' : 'mine');
  const tabLeads = shownTab === 'pushed' ? pushedLeads : myLeads;
  const status = {
    countdown: held ? 'On hold. Tap Call now when you\'re ready.' : `Calling in ${countdown}`,
    calling: 'On call',
    outcome: talkSeconds ? `Connected, ${talkSeconds} s` : 'Not connected',
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
          <View style={styles.leadCard}>
            <Text style={styles.cardStatus}>{status}</Text>
            <Text style={styles.cardName} numberOfLines={1}>{lead.name || 'No name'}</Text>
            <Text style={styles.cardMeta}>{pretty(lead.phone)}</Text>
            {!!lead.stage && <Text style={styles.cardMeta}>{lead.stage}{lead.pushed ? ', pushed by your TL' : ''}</Text>}
            <LeadDetails details={lead.details} compact />
            <LeadHistory history={histories[lead.prospectId] || {}} compact />
          </View>

          <Text style={styles.sectionTitle}>
            {phase === 'reason' ? "Why didn't it connect?" : form ? form.name : 'How did the call go?'}
          </Text>
          <Text style={styles.sectionHint}>
            {phase === 'reason' ? `Tap a reason to save the ${form.name}.` : form ? 'Fill in this call, then tap Save.' : 'Tap one to save it.'}
          </Text>

          {phase === 'reason' && (
            <ScrollView style={styles.outcomes}>
              {reasons.map((r, i) => (
                <Pressable
                  key={r}
                  accessibilityRole="button"
                  disabled={saving}
                  style={({ pressed }) => [styles.outcome, i === reasons.length - 1 && styles.lastRow, pressed && styles.pressed]}
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
            <Text style={styles.fullForm} onPress={() => setPhase('outcome')}>Fill the full form instead</Text>
          )}

          {phase === 'outcome' && form && (
            <View style={styles.formBox}>
              <ActivityForm form={form} values={values} onChange={setValues} />
            </View>
          )}

          {phase === 'outcome' && !form && (
            <ScrollView style={styles.outcomes}>
              {OUTCOMES.map(([value, label], i) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.outcome, i === OUTCOMES.length - 1 && styles.lastRow, pressed && styles.pressed]}
                  onPress={() => chooseOutcome(value, label)}
                >
                  <Text style={styles.outcomeText}>{label}</Text>
                </Pressable>
              ))}
            </ScrollView>
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
        <ScrollView
          key={lead.prospectId} // a fresh screen per lead: starts at the top, no scroll carried over
          contentContainerStyle={styles.call}
          onScrollBeginDrag={hold} // reading: don't call yet
        >
          <View style={styles.statusRow}>
            {phase === 'calling' && <View style={styles.liveDot} />}
            <Text style={styles.status}>{status}</Text>
          </View>
          <Text style={styles.callName}>{lead.name || 'No name'}</Text>
          <Text style={styles.callMeta}>{pretty(lead.phone)}</Text>
          <Text style={styles.callMeta}>{lead.stage}</Text>
          {lead.pushed && <Text style={styles.callMeta}>Pushed by your TL</Text>}
          <LeadDetails details={lead.details} />
          <LeadHistory history={histories[lead.prospectId] || {}} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {queueInfo ? (
            (phase === 'done' || !left) && (
              <View style={styles.caughtUp}>
                <Text style={styles.caughtUpTitle}>All caught up</Text>
                <Text style={styles.muted}>No leads to call right now. New ones show up here; ☰ → Refresh leads checks at once.</Text>
              </View>
            )
          ) : (
            <View accessibilityLabel="Loading your leads">
              <View style={styles.columns}>
                <Skeleton style={{ flex: 1, height: 112, borderRadius: 16 }} />
                <Skeleton style={{ flex: 1, height: 112, borderRadius: 16 }} />
              </View>
              <Skeleton style={{ width: 120, height: 14, marginTop: 28, marginBottom: 8 }} />
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={styles.row}>
                  <Skeleton style={{ flex: 1, height: 18, marginRight: 48 }} />
                  <Skeleton style={{ width: 72, height: 14 }} />
                </View>
              ))}
            </View>
          )}
          {queueInfo?.rule && <Text style={styles.muted}>From {queueInfo.rule.listName}, since {queueInfo.rule.startTime}</Text>}

          {!granted && <Text style={styles.notice}>Allow calls, phone state and call log to start dialing.</Text>}
          {formState === 'failed' && (
            <Text style={styles.notice}>
              Couldn't load your call form, so dialing is off.{' '}
              <Text style={styles.noticeLink} onPress={loadForm}>Try again</Text>
            </Text>
          )}
          {!canFront && (
            <Text style={styles.notice}>
              Turn on "Display over other apps" so the dialer returns after each call.{' '}
              <Text style={styles.noticeLink} onPress={() => Dialer.openBringToFrontSettings()}>Open settings</Text>
            </Text>
          )}

          {phase !== 'done' && !!left && (
            <>
              <View style={styles.columns} accessibilityRole="tablist">
                {[
                  ['pushed', 1, 'Pushed by your TL', pushedLeads.length, pushedLeads.length ? 'Called first' : 'None right now'],
                  ['mine', 2, 'Your leads', myLeads.length, pushedLeads.length ? 'Called next, newest first' : 'Newest first'],
                ].map(([key, rank, label, n, hint]) => (
                  <Pressable
                    key={key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: shownTab === key }}
                    accessibilityLabel={`${rank}. ${label}, ${n} leads. ${hint}`}
                    style={[styles.column, shownTab === key && styles.columnOn]}
                    onPress={() => setTab(key)}
                  >
                    <View style={styles.columnTop}>
                      <View style={[styles.rank, shownTab === key && styles.rankOn]}>
                        <Text style={[styles.rankText, shownTab === key && styles.rankTextOn]}>{rank}</Text>
                      </View>
                      <Text style={[styles.columnCount, !n && styles.orderCountZero]}>{n}</Text>
                    </View>
                    <Text style={styles.orderLabel} numberOfLines={1}>{label}</Text>
                    <Text style={styles.orderHint} numberOfLines={2}>{hint}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.listTitle}>{shownTab === 'pushed' ? 'Pushed by your TL' : 'Your leads'}</Text>
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
              {!tabLeads.length && <Text style={styles.more}>None right now.</Text>}
            </>
          )}
        </ScrollView>
      )}

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
        {phase === 'countdown' && !held && (
          <View style={styles.pair}>
            <Btn title="Hold" kind="plain" onPress={hold} style={styles.half} />
            <Btn title="Skip" kind="plain" onPress={skip} style={styles.half} />
          </View>
        )}
        {phase === 'countdown' && held && (
          <>
            <View style={styles.pair}>
              <Btn title="Call now" onPress={() => { setHeldId(null); dial(); }} style={styles.half} />
              <Btn title="Skip" kind="plain" onPress={skip} style={styles.half} />
            </View>
            <Text style={styles.backLink} onPress={pause}>Back to list</Text>
          </>
        )}
        {phase === 'calling' && (
          <View style={styles.pair}>
            <Btn title="Pause after" kind="plain" onPress={pause} style={styles.half} />
            <Btn title="Call ended" kind="plain" onPress={() => finishCall(true)} style={styles.half} />
          </View>
        )}
        {phase === 'outcome' && !form && <Btn title="Pause after this" kind="plain" onPress={pause} />}
        {phase === 'reason' && <Btn title="Pause after this" kind="plain" onPress={pause} />}
        {phase === 'outcome' && form && (
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

  list: { paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 },
  count: { fontSize: 72, fontWeight: '300', color: colors.text, lineHeight: 80 },
  countLabel: { fontSize: 17, color: colors.text, marginBottom: 20 },
  notice: { fontSize: 15, lineHeight: 22, color: colors.text, marginTop: 24 },
  noticeLink: { textDecorationLine: 'underline' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 17, color: colors.text },
  rowAbout: { fontSize: 13, color: colors.muted },
  rowAge: { fontSize: 13, color: colors.muted },
  caughtUp: { gap: 8, marginBottom: 24 },
  caughtUpTitle: { fontSize: 34, fontWeight: '300', color: colors.text },
  columns: { flexDirection: 'row', gap: 12 },
  column: { ...card, flex: 1, padding: 16, gap: 2 },
  columnOn: { borderColor: colors.text, borderWidth: 1.5 },
  columnTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  columnCount: { fontSize: 30, fontWeight: '300', color: colors.text, fontVariant: ['tabular-nums'] },
  rank: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: '#C9CBD0', alignItems: 'center', justifyContent: 'center' },
  rankOn: { backgroundColor: colors.text, borderColor: colors.text },
  rankText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  rankTextOn: { color: colors.bg },
  orderLabel: { fontSize: 17, fontWeight: '600', color: colors.text },
  orderHint: { fontSize: 13, color: colors.muted, marginTop: 2 },
  orderCountZero: { color: colors.muted },
  listTitle: { fontSize: 13, color: colors.muted, marginTop: 24, marginBottom: 2 },
  more: { fontSize: 15, color: colors.muted, paddingVertical: 16 },

  call: { flexGrow: 1, paddingHorizontal: 24, paddingVertical: 24, justifyContent: 'center' },
  history: { marginTop: 24, gap: 4 },
  historyTitle: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  historyRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  historyHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  historyWhat: { flex: 1, fontSize: 15, fontWeight: '500', color: colors.text },
  historyAt: { fontSize: 13, color: colors.muted },
  historySub: { fontSize: 14, color: colors.muted, marginTop: 2 },
  historyBy: { fontSize: 13, color: colors.muted, marginTop: 1 },
  mark: { flex: 1, paddingHorizontal: 24, paddingTop: 16 },
  leadCard: { ...card, backgroundColor: '#F7F7F7', padding: 16, marginBottom: 24 },
  cardStatus: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  cardName: { fontSize: 22, fontWeight: '600', color: colors.text, marginBottom: 2 },
  cardMeta: { fontSize: 15, color: colors.muted, lineHeight: 22 },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: colors.text },
  sectionHint: { fontSize: 15, color: colors.muted, marginTop: 2, marginBottom: 12 },
  formBox: { flex: 1 },
  fullForm: { fontSize: 15, color: colors.text, textDecorationLine: 'underline', paddingVertical: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  status: { fontSize: 15, color: colors.muted },
  callName: { fontSize: 34, fontWeight: '600', color: colors.text, marginBottom: 8 },
  callMeta: { fontSize: 17, color: colors.muted, lineHeight: 26 },
  outcomes: { flexGrow: 0, ...card },
  outcome: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  lastRow: { borderBottomWidth: 0 },
  outcomeText: { fontSize: 18, color: colors.text },
  pressed: { backgroundColor: '#F5F5F5' },

  details: { ...card, marginTop: 24, paddingHorizontal: 16, paddingVertical: 8 },
  detailsCompact: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DADADA' },
  detailRow: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  detailLabel: { width: 84, fontSize: 15, color: colors.muted },
  detailValue: { flex: 1, fontSize: 15, color: colors.text },
  detailSmall: { fontSize: 13 },
  footnote: { paddingHorizontal: 24, paddingBottom: 8, fontSize: 14, color: colors.muted },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  pair: { flexDirection: 'row', gap: 12 },
  backLink: { textAlign: 'center', fontSize: 15, color: colors.muted, paddingTop: 12 },
  half: { flex: 1 },
});
