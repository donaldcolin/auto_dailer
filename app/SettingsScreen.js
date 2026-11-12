import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, View } from 'react-native';
import Dialer from './modules/dialer';
import { loadPrefs, savePrefs } from './lib/prefs';
import { Btn, card, colors } from './ui';

function readSims() {
  try { return Dialer.listSims(); } catch { return []; }
}

// The SIM calls go out from (dual-SIM phones carry a personal and a business SIM), opening each lead on the laptop,
// and the way into Call recordings and the LeadSquared key.
export default function SettingsScreen({ onClose, chooseSim, onRecordings, onKey }) {
  const [prefs, setPrefs] = useState(loadPrefs());
  const [sims] = useState(readSims);
  const saved = sims.find((s) => s.id === prefs.simId);
  const label = (s) => [`SIM ${s.slot}`, s.name, s.carrier !== s.name && s.carrier].filter(Boolean).join(', ');

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.section}>Call from</Text>
        {sims.length > 1 ? (
          <>
            <Text style={styles.hint}>
              {chooseSim && !saved ? 'Choose the SIM to call from. Pick your business SIM.'
                : prefs.simId != null && !saved ? 'The SIM you chose is no longer in this phone. Choose again.'
                : 'Every call goes out from this SIM.'}
            </Text>
            {sims.map((s) => (
              <Pressable
                key={s.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: s.id === prefs.simId }}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                onPress={() => setPrefs(savePrefs({ simId: s.id, simName: label(s) }))}
              >
                <Text style={[styles.rowText, { flex: 1 }]}>{label(s)}</Text>
                {s.id === prefs.simId && <Ionicons name="checkmark" size={22} color={colors.text} />}
              </Pressable>
            ))}
          </>
        ) : (
          <Text style={styles.hint}>{sims.length ? 'This phone has one SIM, so calls go out from it.' : 'No SIM found.'}</Text>
        )}

        <Text style={styles.section}>Laptop</Text>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowText}>Open leads on my laptop</Text>
            <Text style={styles.meta}>Each lead opens in LeadSquared on your laptop when its call starts. Needs the Dialer extension in Chrome.</Text>
          </View>
          <Switch
            value={!!prefs.autoLaptop}
            onValueChange={(v) => setPrefs(savePrefs({ autoLaptop: v }))}
            accessibilityLabel="Open leads on my laptop"
          />
        </View>

        <Text style={styles.section}>More</Text>
        {[['mic-outline', 'Call recordings', onRecordings], ['key-outline', 'Update LeadSquared key', onKey]].map(([icon, label, onPress]) => (
          <Pressable key={label} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onPress}>
            <Ionicons name={icon} size={20} color={colors.text} />
            <Text style={[styles.rowText, { flex: 1 }]}>{label}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Btn title="Done" kind="plain" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 24, paddingTop: (StatusBar.currentHeight || 24) + 24, paddingBottom: 24, gap: 12 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '600', color: colors.text, marginBottom: 8 },
  section: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 8 },
  hint: { fontSize: 15, lineHeight: 22, color: colors.muted },
  row: { ...card, backgroundColor: '#F7F7F7', flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 12 },
  pressed: { backgroundColor: '#EBEBEB' },
  rowText: { fontSize: 17, color: colors.text },
  meta: { fontSize: 14, lineHeight: 20, color: colors.muted, marginTop: 2 },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
});
