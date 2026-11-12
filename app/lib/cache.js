// The last copy of something from the server, kept on the phone so screens open at once and refresh behind.
export function cached(key) {
  try { return JSON.parse(localStorage.getItem(`cache-${key}`)); } catch { return null; }
}
export function remember(key, value) {
  try { localStorage.setItem(`cache-${key}`, JSON.stringify(value)); } catch {}
}
