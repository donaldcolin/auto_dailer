import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import DialerScreen from './DialerScreen';
import LoginScreen from './LoginScreen';
import { supabase } from './lib/supabase';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still reading the saved session

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  }
  return (
    <>
      {session ? <DialerScreen key={session.user.id} /> : <LoginScreen />}
      {/* The app is always white, so status bar icons are always dark (auto would turn them white in dark mode). */}
      <StatusBar style="dark" />
    </>
  );
}
