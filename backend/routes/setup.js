const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, forgetProfile } = require('../middleware/auth');
const lsqKeys = require('../services/lsq_keys');

const router = express.Router();
const salesOpen = () => process.env.SALES_READY === '1';

function readKeys(body, res) {
  const accessKey = String(body?.accessKey ?? '').trim();
  const secretKey = String(body?.secretKey ?? '').trim();
  if (!accessKey || !secretKey) {
    res.status(400).json({ error: 'Enter both the Access Key and the Secret Key.' });
    return null;
  }
  return { accessKey, secretKey };
}

// Saves only keys LSQ accepts. Returns false after answering when it doesn't.
async function checkAndSave(userId, keys, res) {
  let ok;
  try {
    ok = await lsqKeys.keysWork(keys);
  } catch (err) {
    console.error('[setup] key check failed:', err.response?.status || err.message);
    res.status(502).json({ error: "Couldn't reach LeadSquared to check your keys. Try again." });
    return false;
  }
  if (!ok) {
    res.status(400).json({ code: 'lsq_key_rejected', error: 'LeadSquared refused these keys. Copy both again from My Profile > Settings > API and Webhooks.' });
    return false;
  }
  await lsqKeys.saveKeys(userId, keys);
  return true;
}

// First-time setup: the team (once, then locked) and the person's own LSQ keys.
router.post('/', requireAuth, async (req, res) => {
  const { mode } = req.body || {};
  if (!['hr', 'sales'].includes(mode)) return res.status(400).json({ error: 'Choose HR or Sales.' });
  if (req.profile.mode) return res.status(409).json({ error: 'Your team is already set and can\'t be changed. Ask your manager if this is wrong.' });
  if (mode === 'sales' && !salesOpen()) return res.status(403).json({ error: 'Sales isn\'t open on the dialer yet.' });
  const keys = readKeys(req.body, res);
  if (!keys || !(await checkAndSave(req.profile.id, keys, res))) return;

  // Conditional, so two setups at once can't change a mode that was just locked.
  const { data, error } = await supabase.from('users').update({ mode }).eq('id', req.profile.id).is('mode', null).select('id');
  if (error) throw error;
  forgetProfile(req.profile.id);
  if (!data.length) return res.status(409).json({ error: 'Your team is already set and can\'t be changed. Ask your manager if this is wrong.' });
  res.status(201).json({ ok: true });
});

// New keys only (changed in LSQ, or rejected on a save). The team can't change here.
router.put('/keys', requireAuth, async (req, res) => {
  if (!req.profile.mode) return res.status(409).json({ error: 'Finish setup first.' });
  const keys = readKeys(req.body, res);
  if (!keys || !(await checkAndSave(req.profile.id, keys, res))) return;
  res.json({ ok: true });
});

module.exports = router;
module.exports.salesOpen = salesOpen;
