import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import DialerScreen from './DialerScreen';
import LoginScreen from './LoginScreen';
import SetupScreen from './SetupScreen';
import { api } from './lib/api';
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

  const userId = session?.user.id;
  function loadMe() {
    setMeError(null);
    api('/api/me').then(setMe).catch((e) => setMeError(e.message));
  }
  useEffect(() => {
    setMe(null);
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
  else screen = <DialerScreen key={userId} me={me} />;

  return (
    <>
      {screen}
      {/* The app is always white, so status bar icons are always dark (auto would turn them white in dark mode). */}
      <StatusBar style="dark" />
    </>
  );
}
