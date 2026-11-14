require('dotenv').config();
const axios = require('axios');

// LeadSquared's limits, measured 2026-11-14 with the org key: lead reads (Leads.Get, Leads.GetById,
// Leads/Retrieve/…) allow 15 per 5 s; other APIs allow more (LeadsMetaData.Get took 29 before refusing).
// So lead reads get their own lane of 3 per 1.1 s (at most 15 in any 5 s), and everything shares 5 per 1.1 s.
// Activity advanced search returned 429s at 5 per 1.1 s (2026-11-14), so it shares the slow lane.
// shortcut: per-process counters, fine with one backend instance; needs a shared store if Node is scaled out.
const WINDOW_MS = 1100; // 10% margin so network jitter can't squeeze one more into LSQ's window
const lane = max => ({ max, starts: [] });
const ALL = lane(5);
const LEAD_READS = lane(3);
const isLeadRead = url => /LeadManagement\.svc\/Leads[./]|Activity\/Retrieve\/BySearchParameter/.test(url || '');

async function waitForSlot(l) {
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    l.starts = l.starts.filter(t => now - t < WINDOW_MS);
    if (l.starts.length < l.max) {
      l.starts.push(now);
      if (now - start > 1000) console.log(`[lsq] waited ${now - start}ms for a slot (${l.max}/s lane)`);
      return;
    }
    await new Promise(r => setTimeout(r, WINDOW_MS - (now - l.starts[0])));
  }
}

// Every LSQ call goes through this client so the limits cover queue, history and saves together.
const lsqClient = axios.create({ timeout: 10000 });
lsqClient.interceptors.request.use(async (config) => {
  if (isLeadRead(config.url)) await waitForSlot(LEAD_READS);
  await waitForSlot(ALL);
  return config;
});

// If LSQ still refuses (HTTP 429: another system on the same limit, such as the QC app),
// wait out its window and try again, up to twice, instead of failing the caller's request.
const RETRY_429_MS = 5500;
lsqClient.interceptors.response.use(undefined, async (err) => {
  const config = err.config;
  if (err.response?.status !== 429 || !config || (config._retries || 0) >= 2) throw err;
  config._retries = (config._retries || 0) + 1;
  console.log(`[lsq] 429 from LeadSquared, retry ${config._retries} in ${RETRY_429_MS}ms`); // path only: the URL holds keys
  await new Promise(r => setTimeout(r, RETRY_429_MS));
  return lsqClient(config);
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
  isLeadRead,
  lsqClient,
  lsqParams,
  lsqUrl
};
