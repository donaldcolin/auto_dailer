import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Button, PermissionsAndroid, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Dialer from './modules/dialer';

// Step 0 phone test: place one SIM call, watch call state, read talk time from the call log.
const PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
];

export default function App() {
  const [number, setNumber] = useState('');
  const [granted, setGranted] = useState(false);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const call = useRef({ since: 0, sawOffhook: false });

  const addLog = (line) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);

  useEffect(() => {
    PermissionsAndroid.requestMultiple(PERMISSIONS).then((res) => {
      const ok = PERMISSIONS.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
      setGranted(ok);
      if (!ok) return;
      Dialer.startCallStateListener();
    });
    const sub = Dialer.addListener('onCallState', ({ state }) => {
      addLog(`state ${state}`);
      if (state === 'OFFHOOK') call.current.sawOffhook = true;
      if (state === 'IDLE' && call.current.sawOffhook) {
        call.current.sawOffhook = false;
        readResult();
      }
    });
    return () => {
      sub.remove();
      Dialer.stopCallStateListener();
    };
  }, []);

  // The call log row can land a moment after IDLE, so retry for a few seconds.
  async function readResult() {
    for (let i = 0; i < 6; i++) {
      const row = await Dialer.lastOutgoingCall(call.current.since);
      if (row) {
        setResult(row);
        addLog(`call log: ${row.durationSec}s → ${row.durationSec > 0 ? 'CONNECTED' : 'NO ANSWER'}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    addLog('call log: no outgoing call found');
  }

  function startCall() {
    call.current = { since: Date.now() - 2000, sawOffhook: false };
    setResult(null);
    addLog(`dialing ${number}`);
    Dialer.placeCall(number.trim());
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Dialer — phone test</Text>
      {!granted && <Text style={styles.warn}>Allow phone, call log and call permissions to test.</Text>}
      <TextInput
        style={styles.input}
        placeholder="Team phone number"
        keyboardType="phone-pad"
        value={number}
        onChangeText={setNumber}
      />
      <Button title="Call" onPress={startCall} disabled={!granted || !number.trim()} />
      <View style={styles.gap} />
      <Button title="Read call log again" onPress={readResult} disabled={!granted} />
      {result && (
        <Text style={styles.result}>
          {result.durationSec > 0 ? `Connected, ${result.durationSec}s talk time` : 'No answer (0s)'}
        </Text>
      )}
      <ScrollView style={styles.log}>
        {log.map((line, i) => (
          <Text key={i} style={styles.logLine}>{line}</Text>
        ))}
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 20, paddingTop: 60 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 16 },
  warn: { color: '#b00020', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 18, marginBottom: 12 },
  gap: { height: 8 },
  result: { fontSize: 20, fontWeight: '600', marginVertical: 16 },
  log: { marginTop: 12, borderTopWidth: 1, borderColor: '#eee' },
  logLine: { fontFamily: 'monospace', fontSize: 13, paddingVertical: 2 },
});
