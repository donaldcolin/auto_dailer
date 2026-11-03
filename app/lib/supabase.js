import 'expo-sqlite/localStorage/install';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  // PKCE: Google sign-in returns a one-time code to dialer://auth, swapped for a session in LoginScreen.
  { auth: { storage: localStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: 'pkce' } }
);

// Refresh the session only while the app is in front.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
