const text = document.getElementById('text');
const btn = document.getElementById('btn');
const send = type => chrome.runtime.sendMessage({ type });

async function show() {
  const { email } = await send('status');
  btn.hidden = false;
  if (email) {
    text.textContent = `Signed in as ${email}. Tap "Open on laptop" in the Dialer app and the lead opens here.`;
    btn.textContent = 'Sign out';
    btn.className = 'plain';
    btn.onclick = async () => { await send('signOut'); show(); };
  } else {
    text.textContent = 'Sign in with the same Google account as the Dialer app.';
    btn.textContent = 'Sign in with Google';
    btn.className = '';
    btn.onclick = async () => {
      btn.disabled = true;
      const { error } = await send('signIn');
      btn.disabled = false;
      if (error) { text.textContent = error; text.className = 'error'; return; }
      text.className = '';
      show();
    };
  }
}
show();
