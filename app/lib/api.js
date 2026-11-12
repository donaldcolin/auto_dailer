import { supabase } from './supabase';

export const OFFLINE = 'No internet connection. Check your network and try again.';

// Calls the dialer backend with the signed-in user's token. Throws with the backend's error message.
export async function api(path, { method = 'GET', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${data.session?.access_token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).catch(() => { throw new Error(OFFLINE); });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { code: json?.code, status: res.status });
  return json;
}
