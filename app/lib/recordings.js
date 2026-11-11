import Dialer from '../modules/dialer';

// This phone's recording folder, picked once in Call recordings, and what's been copied for Callyzer since.
// { folder, since, done: [{ n: file name, t: copied at }], lastCopyAt, total }
const KEY = 'recordings';
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // only recordings from the last 3 days are copied, so names older than that can go

export function loadRecordings() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
export function saveRecordings(value) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {}
}

let running = false;
// Copies new recordings into Callyzer's folder. Never throws: it must not get in the way of a call.
export async function copyRecordings() {
  const s = loadRecordings();
  if (!s?.folder || running) return 0;
  running = true;
  try {
    if (!Dialer.hasAllFilesAccess()) return 0;
    const now = Date.now();
    const done = (s.done || []).filter((d) => now - d.t < KEEP_MS);
    const names = await Dialer.copyNewRecordings(s.folder, Math.max(s.since, now - KEEP_MS), done.map((d) => d.n));
    saveRecordings({
      ...s,
      done: [...done, ...names.map((n) => ({ n, t: now }))],
      ...(names.length && { lastCopyAt: now, total: (s.total || 0) + names.length }),
    });
    return names.length;
  } catch {
    return 0;
  } finally {
    running = false;
  }
}

// The phone's recording folder isn't known yet: find the audio file that appeared when the last answered call
// ended, preferring folders named like call recordings, and remember its folder.
async function learnFolder() {
  const since = Date.now() - 10 * 60 * 1000;
  const calls = (await Promise.all([Dialer.lastOutgoingCall(since), Dialer.lastIncomingCall(since)]))
    .filter((c) => c?.durationSec > 0)
    .sort((a, b) => b.date - a.date);
  const call = calls[0];
  if (!call) return null;
  const end = call.date + call.durationSec * 1000;
  const near = (await Dialer.findRecentAudio(call.date - 5000)).filter((f) => Math.abs(f.modified - end) < 90000);
  const named = (f) => (/call|record/i.test(f.folder) ? 0 : 1);
  near.sort((a, b) => named(a) - named(b) || Math.abs(a.modified - end) - Math.abs(b.modified - end));
  if (!near.length) return null;
  const s = { folder: near[0].folder, since: call.date - 5000, done: [], total: 0, auto: true };
  saveRecordings(s);
  return s;
}

// After any call, and when the app comes back: learn the folder if needed, then copy what's new. Never throws.
export async function syncRecordings() {
  try {
    if (!Dialer.hasAllFilesAccess()) return;
    if (!loadRecordings()?.folder && !(await learnFolder())) return;
    await copyRecordings();
  } catch {}
}

// The recorder may still be finishing the file when the call ends, so look now and twice more.
export function syncRecordingsSoon() {
  syncRecordings();
  setTimeout(syncRecordings, 10000);
  setTimeout(syncRecordings, 30000);
}
