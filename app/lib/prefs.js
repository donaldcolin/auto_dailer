// This phone's preferences: { simId, simName, autoLaptop }. On the phone, since the SIM belongs to the phone.
const KEY = 'prefs';

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function savePrefs(change) {
  const next = { ...loadPrefs(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}
