import { useEffect, useRef, useState } from 'react';
import { AppState, Image, PermissionsAndroid, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Dialer from './modules/dialer';
import { api } from './lib/api';
import { supabase } from './lib/supabase';
import { Btn, colors, logo } from './ui';

const PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
];
const COUNTDOWN_SEC = 5;
const NO_ANSWER_PAUSE_MS = 3000;
// shortcut: placeholder outcomes for testing; must match backend/routes/disposition.js.
const OUTCOMES = [
  ['interested', 'Interested'],
  ['call_back', 'Call back'],
  ['not_interested', 'Not interested'],
  ['wrong_number', 'Wrong number'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dialable = (phone) => String(phone).replace(/[^\d+]/g, ''); // LSQ stores "+91-98…"
// "+91-8431772316" → "+91 84317 72316"
const pretty = (phone) => dialable(phone).replace(/^(\+91)?(\d{5})(\d{5})$/, (_, cc, a, b) => `${cc ? cc + ' ' : ''}${a} ${b}`);

/**
 * Progressive dialer: one lead at a time from /api/queue.
 * idle → countdown → calling → (0 s: auto No answer | >0 s: outcome) → next lead.
 * Every lead dialed or skipped is saved, so the next /api/queue no longer returns it.
 */
export default function DialerScreen() {
  const [me, setMe] = useState(null);
  const [granted, setGranted] = useState(false);
  const [canFront, setCanFront] = useState(true);
  const [phase, setPhaseState] = useState('idle'); // idle | loading | countdown | calling | outcome | paused | done
  const [lead, setLead] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null); // { count, source, rule, upcoming }
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC);
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [last, setLast] = useState(null); // "Anosha Employee, interested"
  const [error, setError] = useState(null);

  // Event handlers outlive renders, so the loop's state lives in refs.
  const phaseRef = useRef('idle');
  const pausedRef = useRef(false);
  const callRef = useRef(null); // { lead, ruleId, since, startedAt, sawOffhook, finishing }
  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };

  useEffect(() => {
    api('/api/me').then(setMe).catch((e) => setError(e.message));
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

  // Countdown before each dial; Skip / Pause / Stop leave the 'countdown' phase and so cancel it.
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown === 0) { dial(); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  async function loadQueue() {
    const q = await api('/api/queue');
    setQueueInfo({ count: q.leads.length, source: q.source, rule: q.rule, upcoming: q.leads.slice(0, 5) });
    return q;
  }

  async function next() {
    if (pausedRef.current) { setPhase('paused'); return; }
    setPhase('loading');
    setError(null);
    try {
      const q = await loadQueue();
      if (!q.leads.length) { setLead(null); setPhase('done'); return; }
      setLead({ ...q.leads[0], ruleId: q.rule?.id || null });
      setCountdown(COUNTDOWN_SEC);
      setPhase('countdown');
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
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

    if (seconds > 0) {
      setTalkSeconds(seconds);
      setPhase('outcome');
      return;
    }
    await save('no_answer', 0);
    setLast(`${call.lead.name || 'Lead'}, no answer`);
    await sleep(NO_ANSWER_PAUSE_MS);
    next();
  }

  async function save(outcome, seconds) {
    const { lead: l, startedAt } = callRef.current;
    callRef.current = null;
    try {
      await api('/api/disposition', {
        method: 'POST',
        body: { prospectId: l.prospectId, phone: l.phone, outcome, talkSeconds: seconds, startedAt, ruleId: l.ruleId },
      });
    } catch (e) {
      // shortcut: a failed save is shown, not retried; step 6 adds an offline outbox.
      setError(`Not saved (${outcome}): ${e.message}`);
    }
  }

  async function chooseOutcome(outcome, label) {
    await save(outcome, talkSeconds);
    setLast(`${lead.name || 'Lead'}, ${label.toLowerCase()}`);
    next();
  }

  async function skip() {
    callRef.current = { lead, startedAt: new Date().toISOString() };
    await save('skipped', null);
    setLast(`${lead.name || 'Lead'}, skipped`);
    next();
  }

  const start = () => { pausedRef.current = false; next(); };
  const pause = () => { pausedRef.current = true; if (phaseRef.current === 'countdown') setPhase('paused'); };
  const stop = () => { pausedRef.current = true; setLead(null); setPhase('idle'); };

  const active = ['countdown', 'calling', 'outcome', 'loading'].includes(phase) && lead;
  const left = queueInfo?.count ?? 0;
  const status = {
    countdown: `Calling in ${countdown}`,
    calling: 'On call',
    outcome: `Connected, ${talkSeconds} s`,
    loading: 'Next lead',
  }[phase];

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Image source={logo} style={styles.logo} />
        <Text style={styles.signOut} onPress={() => supabase.auth.signOut()}>Sign out</Text>
      </View>

      {active ? (
        <View style={styles.call}>
          <View style={styles.statusRow}>
            {phase === 'calling' && <View style={styles.liveDot} />}
            <Text style={styles.status}>{status}</Text>
          </View>
          <Text style={styles.callName}>{lead.name || 'No name'}</Text>
          <Text style={styles.callMeta}>{pretty(lead.phone)}</Text>
          <Text style={styles.callMeta}>{lead.stage}</Text>
          {lead.pushed && <Text style={styles.callMeta}>Pushed by your TL</Text>}

          {phase === 'outcome' && (
            <View style={styles.outcomes}>
              {OUTCOMES.map(([value, label]) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.outcome, pressed && styles.pressed]}
                  onPress={() => chooseOutcome(value, label)}
                >
                  <Text style={styles.outcomeText}>{label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.count}>{queueInfo ? left : '–'}</Text>
          <Text style={styles.countLabel}>
            {phase === 'done' || (queueInfo && !left) ? 'All caught up' : left === 1 ? 'lead to call' : 'leads to call'}
          </Text>
          {queueInfo?.rule && <Text style={styles.muted}>From {queueInfo.rule.listName}, since {queueInfo.rule.startTime}</Text>}

          {!granted && <Text style={styles.notice}>Allow calls, phone state and call log to start dialing.</Text>}
          {!canFront && (
            <Text style={styles.notice}>
              Turn on "Display over other apps" so the dialer returns after each call.{' '}
              <Text style={styles.noticeLink} onPress={() => Dialer.openBringToFrontSettings()}>Open settings</Text>
            </Text>
          )}

          {phase !== 'done' && (queueInfo?.upcoming || []).map((l) => (
            <View key={l.prospectId} style={styles.row}>
              <Text style={styles.rowName} numberOfLines={1}>{l.name || 'No name'}</Text>
              {l.pushed ? <Text style={styles.pushed}>Pushed</Text> : <Text style={styles.muted}>{l.stage}</Text>}
            </View>
          ))}
        </ScrollView>
      )}

      {(last || error) && (
        <Text style={[styles.footnote, error && { color: colors.red }]} numberOfLines={2}>{error || `Last: ${last}`}</Text>
      )}

      <View style={styles.footer}>
        {['idle', 'done'].includes(phase) && (
          <Btn title={phase === 'done' ? 'Check again' : 'Start'} onPress={start} disabled={!granted || (phase === 'idle' && !left)} />
        )}
        {phase === 'paused' && (
          <View style={styles.pair}>
            <Btn title="Stop" kind="plain" onPress={stop} style={styles.half} />
            <Btn title="Resume" onPress={start} style={styles.half} />
          </View>
        )}
        {phase === 'countdown' && (
          <View style={styles.pair}>
            <Btn title="Pause" kind="plain" onPress={pause} style={styles.half} />
            <Btn title="Skip" kind="plain" onPress={skip} style={styles.half} />
          </View>
        )}
        {phase === 'calling' && (
          <View style={styles.pair}>
            <Btn title="Pause after" kind="plain" onPress={pause} style={styles.half} />
            <Btn title="Call ended" kind="plain" onPress={() => finishCall(true)} style={styles.half} />
          </View>
        )}
        {phase === 'outcome' && <Btn title="Pause after this" kind="plain" onPress={pause} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 56, paddingBottom: 8 },
  logo: { width: 22, height: 25 },
  signOut: { color: colors.muted, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 15 },

  list: { paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 },
  count: { fontSize: 72, fontWeight: '300', color: colors.text, lineHeight: 80 },
  countLabel: { fontSize: 17, color: colors.text, marginBottom: 32 },
  notice: { fontSize: 15, lineHeight: 22, color: colors.text, marginTop: 24 },
  noticeLink: { textDecorationLine: 'underline' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowName: { flex: 1, fontSize: 17, color: colors.text },
  pushed: { fontSize: 15, fontWeight: '600', color: colors.text },

  call: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  status: { fontSize: 15, color: colors.muted },
  callName: { fontSize: 34, fontWeight: '600', color: colors.text, marginBottom: 8 },
  callMeta: { fontSize: 17, color: colors.muted, lineHeight: 26 },
  outcomes: { marginTop: 32, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  outcome: { paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  outcomeText: { fontSize: 18, color: colors.text },
  pressed: { backgroundColor: '#F5F5F5' },

  footnote: { paddingHorizontal: 24, paddingBottom: 8, fontSize: 14, color: colors.muted },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  pair: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
});
