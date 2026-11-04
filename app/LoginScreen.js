import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { supabase } from './lib/supabase';
import { Btn, colors, wordmark } from './ui';

// Must be listed in Supabase → Authentication → URL Configuration → Redirect URLs.
const REDIRECT = 'dialer://auth';

// Google sign-in in the phone's browser; Supabase hands back a code that becomes the session.
export default function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: REDIRECT, skipBrowserRedirect: true, queryParams: { hd: 'kalvium.com', prompt: 'select_account' } },
      });
      if (error) throw error;
      const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT);
      if (result.type !== 'success') return; // closed the browser
      const url = new URL(result.url);
      const code = url.searchParams.get('code');
      if (!code) throw new Error(url.searchParams.get('error_description') || 'Google sign-in did not finish');
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) throw exchangeError;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.top}>
        <Image source={wordmark} style={styles.wordmark} accessibilityLabel="Kalvium" />
        <Text style={styles.title}>Dialer</Text>
      </View>
      <View style={styles.bottom}>
        <Btn title={busy ? 'Opening Google…' : 'Sign in with Google'} onPress={signIn} disabled={busy} />
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'space-between' },
  top: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  wordmark: { width: 240, height: 48.5 }, // 2000×404 artwork
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  bottom: { gap: 16, paddingBottom: 32 },
  error: { color: colors.red, fontSize: 15, textAlign: 'center' },
});
