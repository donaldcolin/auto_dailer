import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import * as Application from 'expo-application';
import { ActivityIndicator, Linking, Pressable, StatusBar as RNStatusBar, Text, View } from 'react-native';
import DialerScreen from './DialerScreen';
import LoginScreen from './LoginScreen';
import SetupScreen from './SetupScreen';
import { api } from './lib/api';
import { cached, remember } from './lib/cache';
import { supabase } from './lib/supabase';
import { Btn, colors } from './ui';

const center = { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, padding: 24, gap: 16 };

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still reading the saved session
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // A newer APK than this one (native changes only; everything else arrives over the air).
  const [newBuild, setNewBuild] = useState(false);
  useEffect(() => {
    fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/app-version`).then((r) => r.json())
      .then(({ build }) => setNewBuild(build > Number(Application.nativeBuildVersion)))
      .catch(() => {}); // offline: check again on next open
  }, []);

  const userId = session?.user.id;
  // The last profile opens the dialer at once; the server's copy replaces it. Offline with a saved one, it still opens.
  function loadMe() {
    setMeError(null);
    api('/api/me')
      .then((m) => { setMe(m); remember(`me-${userId}`, m); })
      .catch((e) => setMe((cur) => { if (!cur) setMeError(e.message); return cur; }));
  }
  useEffect(() => {
    setMe(userId ? cached(`me-${userId}`) : null);
    if (userId) loadMe();
  }, [userId]);

  let screen;
  if (session === undefined) screen = <View style={center}><ActivityIndicator /></View>;
  else if (!session) screen = <LoginScreen />;
  else if (meError) {
    screen = (
      <View style={center}>
        <Text style={{ color: colors.text, fontSize: 15, textAlign: 'center' }}>{meError}</Text>
        <Btn title="Try again" onPress={loadMe} />
        <Text style={{ color: colors.muted, fontSize: 15 }} onPress={() => supabase.auth.signOut()}>Sign out</Text>
      </View>
    );
  } else if (!me) screen = <View style={center}><ActivityIndicator /></View>;
  else if (!me.mode || !me.hasKey) screen = <SetupScreen me={me} onDone={loadMe} />;
  else screen = <DialerScreen key={`${userId}-${me.mode}`} me={me} />; // a mode change (from the saved profile) reloads the form

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {newBuild && (
        <Pressable
          accessibilityRole="button"
          onPress={() => Linking.openURL(`${process.env.EXPO_PUBLIC_API_URL}/download`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#F7F7F7', paddingHorizontal: 24, paddingTop: (RNStatusBar.currentHeight || 24) + 12, paddingBottom: 12 }}
        >
          <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>A new version of the app is ready.</Text>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>Update</Text>
        </Pressable>
      )}
      {screen}
      {/* The app is always white, so status bar icons are always dark (auto would turn them white in dark mode). */}
      <StatusBar style="dark" />
    </View>
  );
}
