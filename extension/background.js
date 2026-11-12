// Opens leads sent from the Dialer app ("Open on laptop"). Signed in with the same Google account as the app;
// Supabase Realtime delivers the person's own laptop_opens rows (RLS), and each opens LSQ in a new tab.
importScripts('supabase.js', 'config.js');

const LEAD_URL = id => `https://app-in21.leadsquared.com/LeadDetails?LeadID=${encodeURIComponent(id)}`;
// Service workers have no localStorage: the session lives in chrome.storage.
const storage = {
  getItem: async k => (await chrome.storage.local.get(k))[k] ?? null,
  setItem: (k, v) => chrome.storage.local.set({ [k]: v }),
  removeItem: k => chrome.storage.local.remove(k),
};
const db = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
let channel = null;
let signingIn = null;

// One at a time, so a row from Realtime and the same row from the catch-up never open two tabs.
let opening = Promise.resolve();
function open(row) {
  opening = opening.then(async () => {
    const { opened = [] } = await chrome.storage.local.get('opened');
    if (opened.includes(row.id)) return;
    await chrome.storage.local.set({ opened: [...opened, row.id].slice(-200) });
    await chrome.tabs.create({ url: LEAD_URL(row.prospect_id) });
  }).catch(e => console.error('open failed', e));
  return opening;
}

// Chrome stops idle service workers, so this runs on start and every 30 s: it opens anything sent in the last
// 2 minutes that wasn't opened yet, then makes sure the live subscription is up.
async function connect() {
  const { data: { session } } = await db.auth.getSession(); // refreshes an expired token
  if (!session) {
    if (channel) db.removeChannel(channel);
    channel = null;
    return;
  }
  const { data } = await db.from('laptop_opens').select('id, prospect_id')
    .gte('created_at', new Date(Date.now() - 2 * 60 * 1000).toISOString()).order('id');
  for (const row of data || []) await open(row);
  if (channel?.state === 'joined') return;
  if (channel) db.removeChannel(channel);
  channel = db.channel('laptop-opens')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'laptop_opens', filter: `user_id=eq.${session.user.id}` }, p => open(p.new))
    .subscribe();
}

async function signIn() {
  const url = `${CONFIG.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(chrome.identity.getRedirectURL())}`;
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const p = new URLSearchParams(new URL(back).hash.slice(1));
  if (!p.get('access_token')) throw new Error(p.get('error_description') || 'Sign-in was cancelled');
  const { error } = await db.auth.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token') });
  if (error) throw error;
  // Older requests were meant for whoever was at the laptop then.
  const { data } = await db.from('laptop_opens').select('id').order('id', { ascending: false }).limit(200);
  await chrome.storage.local.set({ opened: (data || []).map(r => r.id) });
  await connect();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = {
    status: async () => ({ email: (await db.auth.getSession()).data.session?.user.email || null }),
    // The popup closes when Google's window opens; a second click joins the open sign-in instead of starting another.
    signIn: async () => { signingIn ||= signIn().finally(() => { signingIn = null; }); await signingIn; return {}; },
    signOut: async () => { await db.auth.signOut(); await connect(); return {}; },
  }[msg.type];
  if (!run) return false;
  run().then(reply, e => reply({ error: e.message }));
  return true; // answers asynchronously
});

chrome.alarms.create('connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
