require('dotenv').config();
const axios = require('axios');

// Org-wide LeadSquared limit: at most 5 requests started per rolling second.
// shortcut: per-process counter, fine with pm2 instances: 1; needs a shared store if Node is scaled out.
const LSQ_MAX_PER_SEC = 5;
const LSQ_WINDOW_MS = 1100; // 10% margin so network jitter can't squeeze 6 into LSQ's 1s window
let _recentStarts = [];

async function waitForLsqSlot() {
  for (;;) {
    const now = Date.now();
    _recentStarts = _recentStarts.filter(t => now - t < LSQ_WINDOW_MS);
    if (_recentStarts.length < LSQ_MAX_PER_SEC) {
      _recentStarts.push(now);
      return;
    }
    await new Promise(r => setTimeout(r, LSQ_WINDOW_MS - (now - _recentStarts[0])));
  }
}

// Every LSQ call goes through this client so the limit covers scanner, UI and search together.
const lsqClient = axios.create({ timeout: 10000 });
lsqClient.interceptors.request.use(async (config) => {
  await waitForLsqSlot();
  return config;
});

function lsqParams() {
  const host = process.env.LSQ_API_HOST || 'https://api-in21.leadsquared.com/v2';
  const accessKey = process.env.LSQ_ACCESS_KEY;
  const secretKey = process.env.LSQ_SECRET_KEY;
  return { host, accessKey, secretKey };
}

function lsqUrl(path) {
  const { host, accessKey, secretKey } = lsqParams();
  return `${host}/${path}?accessKey=${accessKey}&secretKey=${secretKey}`;
}

module.exports = {
  lsqClient,
  lsqParams,
  lsqUrl
};
