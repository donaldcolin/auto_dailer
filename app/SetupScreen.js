import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './lib/api';
import { supabase } from './lib/supabase';
import { Btn, card, colors } from './ui';

const TEAMS = [['hr', 'HR', 'HR Activity after each call'], ['sales', 'Sales', 'BDA Activity after each call']];

/**
 * First sign-in: pick the team (once, it can't change afterwards), then connect the person's own LeadSquared keys,
 * so their activities show them as Created By. With `keysOnly` it just replaces the keys.
 * The pasted keys go to the server and aren't stored on the phone.
 */
export default function SetupScreen({ me, keysOnly, onDone, onCancel }) {
  const lockedTeam = keysOnly || !!me.mode;
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

  function connect() {
    if (lockedTeam) { send(); return; }
    const team = TEAMS.find(([k]) => k === mode)[1];
    Alert.alert(`Join ${team}?`, "You can't change your team later.", [
      { text: 'Go back', style: 'cancel' },
      { text: `Yes, ${team}`, onPress: send },
    ]);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!lockedTeam && (
          <View style={styles.section}>
            <Text style={styles.title}>Choose your team</Text>
            <Text style={styles.hint}>This sets the form you fill after each call. You can't change it later.</Text>
            <View style={card}>
              {TEAMS.map(([key, label, about], i) => {
                const closed = key === 'sales' && !me.salesOpen;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: mode === key, disabled: closed }}
                    disabled={closed}
                    style={({ pressed }) => [styles.team, i === 1 && styles.lastRow, pressed && styles.pressed, closed && styles.closed]}
                    onPress={() => setMode(key)}
                  >
                    <View style={[styles.radio, mode === key && styles.radioOn]}>{mode === key && <View style={styles.radioDot} />}</View>
                    <View style={styles.teamBody}>
                      <Text style={styles.teamName}>{label}</Text>
                      <Text style={styles.teamAbout}>{closed ? 'Opening soon' : about}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.title}>{keysOnly ? 'Update your LeadSquared key' : 'Connect LeadSquared'}</Text>
          <Text style={styles.hint}>
            Your activities are saved under your name with your own key. In LeadSquared, open{' '}
            <Text style={styles.path}>My Profile → Settings → API and Webhooks → API Access Keys</Text>, then copy both keys here.
          </Text>
          <Text style={styles.label}>Access Key</Text>
          <TextInput style={styles.input} value={accessKey} onChangeText={setAccessKey} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Access Key" placeholder="Paste here" placeholderTextColor={colors.muted} />
          <Text style={styles.label}>Secret Key</Text>
          <TextInput style={styles.input} value={secretKey} onChangeText={setSecretKey} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="Secret Key" placeholder="Paste here" placeholderTextColor={colors.muted} />
          {!!error && <Text style={styles.error}>{error}</Text>}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Btn title={busy ? 'Checking…' : 'Connect'} onPress={connect} disabled={busy || !accessKey.trim() || !secretKey.trim()} />
        {keysOnly
          ? <Text style={styles.link} onPress={onCancel}>Cancel</Text>
          : <Text style={styles.link} onPress={() => supabase.auth.signOut()}>Sign out</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 24, paddingTop: (StatusBar.currentHeight || 24) + 32, paddingBottom: 24, gap: 32 },
  section: { gap: 8 },
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, lineHeight: 22, color: colors.muted, marginBottom: 8 },
  path: { color: colors.text, fontWeight: '500' },
  team: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  lastRow: { borderBottomWidth: 0 },
  pressed: { backgroundColor: '#F5F5F5' },
  closed: { opacity: 0.5 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#C9CBD0', alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.text },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.text },
  teamBody: { flex: 1 },
  teamName: { fontSize: 17, fontWeight: '600', color: colors.text },
  teamAbout: { fontSize: 13, color: colors.muted, marginTop: 2 },
  label: { fontSize: 13, color: colors.muted, marginTop: 4 },
  input: { ...card, fontSize: 16, color: colors.text, paddingHorizontal: 16, paddingVertical: 14 },
  error: { fontSize: 15, lineHeight: 22, color: colors.red, marginTop: 4 },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  link: { textAlign: 'center', fontSize: 15, color: colors.muted, paddingTop: 16 },
});
