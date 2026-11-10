const express = require('express');
const { requireAuth } = require('../middleware/auth');
const queue = require('../services/queue');
const history = require('../services/history');
const supabase = require('../config/supabase');

const router = express.Router();

// Recent LSQ activity on one lead, for the call screen. Associates only see their own leads.
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    // Both LSQ reads at once (one after the other took ~5 s); the history is only sent if the owner check passes.
    const [owner, items] = await Promise.all([
      req.profile.access === 'associate' ? queue.readLeadsByIds([req.params.id]).then(([l]) => l?.ownerId) : null,
      history.leadHistory(req.params.id),
    ]);
    if (req.profile.access === 'associate' && owner !== req.profile.lsq_user_id) return res.status(404).json({ error: 'Lead not found' });
    res.json({ history: items });
  } catch (err) {
    console.error('[history]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not load this lead\'s activity' });
  }
});

const last10 = phone => String(phone || '').replace(/\D/g, '').slice(-10);
// Midnight IST (UTC+5:30), as UTC.
const istMidnight = (now = new Date()) => {
  const ist = new Date(now.getTime() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000);
};

// A number that just called in: is it a lead this person called today without getting through? Then the app
// shows that lead's form. The latest dial to the number decides: once it connected, a callback is a normal call.
router.post('/callback', requireAuth, async (req, res) => {
  const digits = last10(req.body?.phone); // in the body, not the URL, so numbers stay out of request logs
  if (digits.length !== 10) return res.json({ lead: null });
  const { data, error } = await supabase.from('dial_attempts')
    .select('prospect_id, phone, outcome')
    .eq('user_id', req.profile.id)
    .gte('started_at', istMidnight().toISOString())
    .neq('outcome', 'skipped')
    .order('started_at', { ascending: false });
  if (error) throw error;
  const latest = data.find(a => last10(a.phone) === digits);
  if (latest?.outcome !== 'no_answer') return res.json({ lead: null });
  const [lead] = await queue.readLeadsByIds([latest.prospect_id]);
  if (!lead || (req.profile.access === 'associate' && lead.ownerId !== req.profile.lsq_user_id)) return res.json({ lead: null });
  res.json({ lead });
});

// "Open on laptop": the person's Chrome extension (signed in as them) gets this row over Supabase Realtime.
router.post('/:id/open-on-laptop', requireAuth, async (req, res) => {
  const { error } = await supabase.from('laptop_opens').insert({ user_id: req.profile.id, prospect_id: req.params.id });
  if (error) throw error;
  res.status(201).json({ ok: true });
});

module.exports = Object.assign(router, { istMidnight });
