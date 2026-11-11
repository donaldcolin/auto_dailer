import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppState, PermissionsAndroid, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import Dialer from './modules/dialer';
import { copyRecordings, loadRecordings, saveRecordings } from './lib/recordings';
import { Btn, card, colors } from './ui';

const LOOK_BACK_MS = 15 * 60 * 1000;
const where = (folder) => `Internal storage/${folder || ''}`.replace(/\/$/, '');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Finds where this phone really saves call recordings (often a hidden folder Callyzer can't pick) and, once picked,
 * the dialer copies each new one into Recordings/Kalvium Calls, the folder Callyzer is pointed at.
 */
export default function RecordingsScreen({ onClose }) {
  const [access, setAccess] = useState(Dialer.hasAllFilesAccess());
  const [setup, setSetup] = useState(loadRecordings());
  const [found, setFound] = useState(null); // [{ folder, count, newest }] after a search
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Back from Android's settings page: read the switch again.
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setAccess(Dialer.hasAllFilesAccess()); });
    return () => sub.remove();
  }, []);

  async function allow() {
    if (Platform.Version >= 30) Dialer.openAllFilesAccessSettings();
    else {
      await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE, PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE]);
      setAccess(Dialer.hasAllFilesAccess());
    }
  }

  async function find() {
    setBusy(true);
    try {
      const files = await Dialer.findRecentAudio(Date.now() - LOOK_BACK_MS);
      const byFolder = new Map();
      for (const f of files) {
        const g = byFolder.get(f.folder) || { folder: f.folder, count: 0, newest: 0 };
        g.count += 1;
        g.newest = Math.max(g.newest, f.modified);
        byFolder.set(f.folder, g);
      }
      setFound([...byFolder.values()].sort((a, b) => b.newest - a.newest));
    } catch {
      setFound([]);
    } finally {
      setBusy(false);
    }
  }

  async function pick(folder) {
    const s = { folder, since: Date.now() - LOOK_BACK_MS, done: [], total: 0 };
    saveRecordings(s);
    setFound(null);
    setBusy(true);
    await copyRecordings(); // the test call's recording goes across at once
    setSetup(loadRecordings());
    setBusy(false);
  }

  function stop() {
    saveRecordings(null);
    setSetup(null);
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Call recordings</Text>
        <Text style={styles.hint}>
          If Callyzer can't find your recordings, the dialer can copy each one into a folder Callyzer can read.
        </Text>

        {!access ? (
          <View style={styles.box}>
            <Text style={styles.boxTitle}>Allow file access</Text>
            <Text style={styles.boxText}>
              The dialer needs "All files access" to find recordings in hidden folders. On the next screen, turn it on for Dialer, then come back.
            </Text>
            <Btn title="Allow access" onPress={allow} style={styles.btn} />
          </View>
        ) : setup ? (
          <>
            <View style={styles.box}>
              <Text style={styles.boxTitle}>Copying your recordings</Text>
              {setup.auto && <Text style={styles.boxText}>Found automatically after your last call.</Text>}
              <Text style={styles.label}>From</Text>
              <Text style={styles.path}>{where(setup.folder)}</Text>
              <Text style={styles.label}>To</Text>
              <Text style={styles.path}>Internal storage/Recordings/Kalvium Calls</Text>
              <Text style={styles.boxText}>
                {setup.total ? `${setup.total} copied, the last at ${clock(setup.lastCopyAt)}.` : 'Nothing copied yet.'} New ones are copied after each call while the dialer is open.
              </Text>
            </View>
            <View style={styles.box}>
              <Text style={styles.boxTitle}>Point Callyzer here, once</Text>
              <Text style={styles.boxText}>In Callyzer, open Settings, then Change Call Recording Location, and choose Recordings, then Kalvium Calls.</Text>
            </View>
            <Text style={styles.link} onPress={stop}>Wrong folder? Choose again</Text>
          </>
        ) : (
          <>
            <View style={styles.box}>
              <Text style={styles.boxTitle}>Find where your phone saves them</Text>
              <Text style={styles.boxText}>The dialer finds the folder by itself after your next answered call, as long as call recording is on in your phone app.</Text>
              <Text style={styles.boxText}>To do it now: make a short test call, come back and tap Find recordings.</Text>
              <Btn title={busy ? 'Looking…' : 'Find recordings'} onPress={find} disabled={busy} style={styles.btn} />
            </View>

            {found?.length === 0 && (
              <View style={styles.box}>
                <Text style={styles.boxTitle}>No recordings from the last 15 minutes</Text>
                <Text style={styles.boxText}>
                  Check that call recording is on in your phone app and try again. If it still finds nothing, your phone app keeps recordings to itself: share each one to Callyzer Biz from the call history instead.
                </Text>
              </View>
            )}
            {found?.length > 0 && (
              <>
                <Text style={styles.section}>Tap the folder with your test call</Text>
                {found.map((g) => (
                  <Pressable
                    key={g.folder}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    onPress={() => pick(g.folder)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.path}>{where(g.folder)}</Text>
                      <Text style={styles.meta}>{g.count} {g.count === 1 ? 'recording' : 'recordings'}, latest {clock(g.newest)}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                  </Pressable>
                ))}
              </>
            )}
          </>
        )}
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
  title: { fontSize: 26, lineHeight: 32, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, lineHeight: 22, color: colors.muted, marginBottom: 8 },
  box: { ...card, backgroundColor: '#F7F7F7', padding: 16, gap: 6 },
  boxTitle: { fontSize: 17, fontWeight: '600', color: colors.text, marginBottom: 2 },
  boxText: { fontSize: 15, lineHeight: 22, color: colors.text },
  btn: { marginTop: 10 },
  label: { fontSize: 13, color: colors.muted, marginTop: 4 },
  path: { fontSize: 15, fontWeight: '500', color: colors.text },
  meta: { fontSize: 14, color: colors.muted, marginTop: 2 },
  section: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 8 },
  row: { ...card, backgroundColor: '#F7F7F7', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 64, paddingHorizontal: 16, paddingVertical: 12 },
  pressed: { backgroundColor: '#EBEBEB' },
  link: { textAlign: 'center', fontSize: 15, color: colors.muted, paddingVertical: 12 },
  footer: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
});
