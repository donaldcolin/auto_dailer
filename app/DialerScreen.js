import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ActivityIndicator, Alert, Animated, AppState, Easing, Image, Modal, PermissionsAndroid, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import SettingsScreen from './SettingsScreen';
import RecordingsScreen from './RecordingsScreen';
import SetupScreen from './SetupScreen';
import Dialer from './modules/dialer';
import { api, OFFLINE } from './lib/api';
import { createCallFlow } from './lib/callFlow';
import { initDialer, useDialer } from './lib/dialerStore';
import { enqueue, flush, onOutboxProblem, waitingLeads } from './lib/outbox';
import { loadPrefs, savePrefs } from './lib/prefs';
import { syncRecordings, syncRecordingsSoon } from './lib/recordings';
import { supabase } from './lib/supabase';
import { Btn, colors, Toast, wordmark } from './ui';
import { styles } from './screens/dialerStyles';
import MarkScreen from './screens/MarkScreen';
import CallScreen from './screens/CallScreen';
import ListScreen from './screens/ListScreen';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Progressive dialer: one lead at a time from /api/queue.
 * idle → countdown → calling → (0 s: reason | >0 s: outcome) → next lead.
 * The caller always marks their team's LSQ activity: one tap on a reason, or the form after a connected call.
 * Every lead dialed or skipped is saved: the next /api/queue leaves called ones out and puts skipped ones at the back.
 */
export default function DialerScreen({ me }) {
  // This person's saved state (each view's last queue, the views, the form) is read before the first draw; what only
  // lasts a session starts fresh, so a restart or a mode change always opens on the list.
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    initDialer(me.email);
    const view = loadPrefs().view || 'own';
    const { queues } = useDialer.getState();
    useDialer.setState({
      phase: 'idle', lead: null, call: null, handled: [], paused: false, values: {}, callback: null, incoming: null,
      pendingIncoming: null, incomingLead: null, queueInfo: null, error: null, toast: null, prefsOpen: null, keyOpen: false,
      saving: false, refreshing: false, slow: false, view, queue: queues[view] || { leads: [], rule: null, source: null, upcoming: [] },
    });
  }
  const countdownBar = useRef(new Animated.Value(1)).current;
  const flow = useMemo(() => createCallFlow({
    me, api, Dialer, enqueue, flush, waitingLeads, loadPrefs, savePrefs, startValues, rememberSticky, countdownBar, sleep, COUNTDOWN_SEC,
  }), []);
  const {
    phase, lead, queueInfo, countdown, held, talkSeconds, callback, incomingLead, toast, error,
    form, formState, values, saving, refreshing, prefsOpen, keyOpen,
  } = useDialer(useShallow((s) => ({
    phase: s.phase, lead: s.lead, queueInfo: s.queueInfo, countdown: s.countdown, held: s.held,
    talkSeconds: s.talkSeconds, callback: s.callback, incomingLead: s.incomingLead, toast: s.toast,
    error: s.error, form: s.form, formState: s.formState, values: s.values, saving: s.saving, refreshing: s.refreshing,
    prefsOpen: s.prefsOpen, keyOpen: s.keyOpen,
  })));
  const set = useDialer.setState;
  const setPrefsOpen = (p) => set({ prefsOpen: p });
  const setKeyOpen = (k) => set({ keyOpen: k });
  const { setError, showToast, start, pause, stop, skip, submit, pickView, refreshNow, openOnLaptop, closePrefs, loadForm, finishCall } = flow;
  const refresh = () => flow.refresh(OFFLINE);

  // Only this screen's own pieces stay here.
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [granted, setGranted] = useState(false);
  const [canFront, setCanFront] = useState(true);
  const [filesAccess, setFilesAccess] = useState(true); // call recordings are copied for Callyzer only with it
  const [menuOpen, setMenuOpen] = useState(false);
  // Recent LSQ activity by lead id: { items } | { failed } | {} while loading. The next lead's is loaded early.
  const [histories, setHistories] = useState({});
  const historyAsked = useRef(new Set());

  useEffect(() => {
    flow.loadForm();
    // The last queue shows at once (leads already called are filtered by the server's reload and the outbox).
    const hadQueue = !!useDialer.getState().queues[useDialer.getState().view]; // an empty one too: "All caught up" at once
    if (hadQueue) flow.pending();
    flow.loadViews();
    PermissionsAndroid.requestMultiple(PERMISSIONS).then((res) => {
      const ok = PERMISSIONS.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
      setGranted(ok);
      if (ok) { Dialer.startCallStateListener(); flow.listenIncoming(); }
    });
    flow.loadShown(!hadQueue).catch((e) => setError(e.message));

    const inSub = Dialer.addListener('onIncoming', flow.onIncoming);
    const callSub = Dialer.addListener('onCallState', ({ state }) => {
      if (state === 'IDLE') syncRecordingsSoon(); // any call that just ended: its recording goes to Callyzer's folder
      flow.onCallState(state);
    });
    // Android may hold our JS while the call screen is on top; back in front, check the call log too.
    setCanFront(Dialer.canBringToFront());
    setFilesAccess(Dialer.hasAllFilesAccess());
    const appSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      setCanFront(Dialer.canBringToFront()); // re-check after returning from Settings
      flow.onAppActive();
      setFilesAccess(Dialer.hasAllFilesAccess());
      syncRecordings();
    });
    syncRecordings();
    // Saves go out in the background; a problem shows here, and clears once they're all sent.
    let shown = null;
    onOutboxProblem((msg, code) => {
      if (msg) { shown = msg; setError(msg); } else setError((e) => (e === shown ? null : e));
      if (code === 'lsq_key_rejected') setKeyOpen(true);
    });
    flush();
    flow.catchUpIncoming();
    const retry = setInterval(flush, 30000);
    return () => {
      clearInterval(retry);
      inSub.remove();
      callSub.remove();
      appSub.remove();
      Dialer.stopCallStateListener();
    };
  }, []);

  // Countdown before each dial; Skip / Pause / Stop leave the 'countdown' phase and so cancel it.
  useEffect(() => {
    if (phase !== 'countdown' || held) return;
    if (countdown === 0) { flow.dial(); return; }
    const t = setTimeout(() => set((s) => ({ countdown: s.countdown - 1 })), 1000);
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
    const { queue, handled } = useDialer.getState();
    loadHistory(queue.leads.find((l) => l.prospectId !== id && !handled.includes(l.prospectId))?.prospectId);
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

  function confirmSignOut() {
    setMenuOpen(false);
    Alert.alert('Sign out?', 'You can sign in again with Google.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() },
    ]);
  }

  const active = phase === 'loading' || (['countdown', 'calling', 'outcome', 'reason'].includes(phase) && lead);
  const marking = phase === 'outcome' || phase === 'reason'; // after a call: lead card on top, what to mark below
  const left = queueInfo?.count ?? 0;
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
              onPress={() => { setMenuOpen(false); refreshNow(); }}
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
        <MarkScreen flow={flow} status={status} histories={histories} />
      ) : active ? (
        <CallScreen status={status} histories={histories} countdownBar={countdownBar} />
      ) : (
        <ListScreen flow={flow} granted={granted} filesAccess={filesAccess} canFront={canFront} onRecordings={() => setRecordingsOpen(true)} />
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

