import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Image, KeyboardAvoidingView, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './lib/api';
import { supabase } from './lib/supabase';
import { Btn, card, colors, wordmark } from './ui';

const TEAMS = [['hr', 'HR', 'Fill in HR Activity after each call'], ['sales', 'Sales', 'Fill in BDA Activity after each call']];
const KEY_STEPS = ['In LeadSquared, open My Profile', 'Go to Settings, then API and Webhooks', 'Open API Access Keys and copy both keys here'];

/**
 * First sign-in: pick the team (once, it can't change afterwards), then connect the person's own LeadSquared keys,
 * so their activities show them as Created By. With `keysOnly` it just replaces the keys.
 * The pasted keys go to the server and aren't stored on the phone.
 */
export default function SetupScreen({ me, keysOnly, onDone, onCancel }) {
  const lockedTeam = keysOnly || !!me.mode;
  const [step, setStep] = useState(lockedTeam ? 2 : 1);
  const [mode, setMode] = useState(me.mode || (me.suggestedMode === 'sales' && !me.salesOpen ? 'hr' : me.suggestedMode));
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (lockedTeam) await api('/api/setup/keys', { method: 'PUT', body: { accessKey, secretKey } });
      else await api('/api/setup', { method: 'POST', body: { mode, accessKey, secretKey } });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function confirmTeam() {
    const team = TEAMS.find(([k]) => k === mode)[1];
    Alert.alert(`Join ${team}?`, "You can't change your team later.", [
      { text: 'Go back', style: 'cancel' },
      { text: `Yes, ${team}`, onPress: () => setStep(2) },
    ]);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!keysOnly && <Image source={wordmark} style={styles.wordmark} accessibilityLabel="Kalvium" />}
        {!lockedTeam && (
          <View style={styles.progress}>
            <Text style={styles.stepText}>Step {step} of 2</Text>
            <View style={styles.bars}>
              <View style={[styles.bar, styles.barOn]} />
              <View style={[styles.bar, step === 2 && styles.barOn]} />
            </View>
          </View>
        )}

        {step === 1 ? (
          <>
            <Text style={styles.title}>Which team are you on?</Text>
            <View style={styles.teams}>
              {TEAMS.map(([key, label, about]) => {
                const closed = key === 'sales' && !me.salesOpen;
                const on = mode === key;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, disabled: closed }}
                    disabled={closed}
                    style={[styles.team, on && styles.teamOn, closed && styles.closed]}
                    onPress={() => setMode(key)}
                  >
                    <View style={styles.teamBody}>
                      <Text style={styles.teamName}>{label}</Text>
                      <Text style={styles.teamAbout}>{closed ? 'Opening soon' : about}</Text>
                    </View>
                    {on && <Ionicons name="checkmark-circle" size={24} color={colors.text} />}
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>{keysOnly ? 'Update your LeadSquared key' : 'Connect LeadSquared'}</Text>
            <Text style={styles.hint}>Your activities are saved under your name with your own key.</Text>
            <View style={styles.keySteps}>
              {KEY_STEPS.map((text, i) => (
                <View key={text} style={styles.keyStep}>
                  <View style={styles.num}><Text style={styles.numText}>{i + 1}</Text></View>
                  <Text style={styles.keyStepText}>{text}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.label}>Access Key</Text>
            <TextInput style={styles.input} value={accessKey} onChangeText={setAccessKey} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Access Key" placeholder="Paste here" placeholderTextColor={colors.muted} />
            <Text style={styles.label}>Secret Key</Text>
            <TextInput style={styles.input} value={secretKey} onChangeText={setSecretKey} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="Secret Key" placeholder="Paste here" placeholderTextColor={colors.muted} />
            {!!error && <Text style={styles.error}>{error}</Text>}
          </>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {step === 1
          ? <Btn title="Continue" onPress={confirmTeam} disabled={!mode} />
          : <Btn title={busy ? 'Checking…' : 'Connect'} onPress={send} disabled={busy || !accessKey.trim() || !secretKey.trim()} />}
        {keysOnly
          ? <Text style={styles.link} onPress={onCancel}>Cancel</Text>
          : step === 2 && !lockedTeam
            ? <Text style={styles.link} onPress={() => { setError(null); setStep(1); }}>Back</Text>
            : <Text style={styles.link} onPress={() => supabase.auth.signOut()}>Sign out</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 24, paddingTop: (StatusBar.currentHeight || 24) + 24, paddingBottom: 24 },
  wordmark: { width: 119, height: 24, marginBottom: 32 }, // 2000×404 artwork
  progress: { gap: 8, marginBottom: 24 },
  stepText: { fontSize: 13, color: colors.muted },
  bars: { flexDirection: 'row', gap: 6 },
  bar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.line },
  barOn: { backgroundColor: colors.text },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, lineHeight: 22, color: colors.muted, marginTop: 8 },
  teams: { gap: 12, marginTop: 24 },
  team: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 84, paddingHorizontal: 20, borderWidth: 1.5, borderColor: colors.line, borderRadius: 16 },
  teamOn: { borderColor: colors.text },
  closed: { opacity: 0.5 },
  teamBody: { flex: 1 },
  teamName: { fontSize: 18, fontWeight: '600', color: colors.text },
  teamAbout: { fontSize: 14, color: colors.muted, marginTop: 2 },
  keySteps: { gap: 12, marginTop: 24, marginBottom: 12 },
  keyStep: { flexDirection: 'row', gap: 12 },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 13, fontWeight: '600', color: colors.text },
  keyStepText: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.text },
  label: { fontSize: 14, fontWeight: '500', color: colors.text, marginTop: 16, marginBottom: 8 },
  input: { ...card, fontSize: 16, color: colors.text, paddingHorizontal: 16, paddingVertical: 14 },
  error: { fontSize: 15, lineHeight: 22, color: colors.red, marginTop: 12 },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  link: { textAlign: 'center', fontSize: 15, color: colors.muted, paddingTop: 16 },
});
