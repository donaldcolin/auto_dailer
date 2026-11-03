const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// shortcut: placeholder outcomes for testing; replace with the real list once it's decided (PRD open question).
const OUTCOMES = ['no_answer', 'interested', 'not_interested', 'call_back', 'wrong_number', 'skipped'];

// One row per dial. The call itself reaches LSQ through Callyzer, so nothing is written to LSQ here.
router.post('/', requireAuth, async (req, res) => {
  const { prospectId, phone, outcome, talkSeconds, startedAt, ruleId, note } = req.body || {};
  if (!prospectId || typeof prospectId !== 'string') return res.status(400).json({ error: 'prospectId is required' });
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
  if (talkSeconds != null && !(Number.isInteger(talkSeconds) && talkSeconds >= 0)) {
    return res.status(400).json({ error: 'talkSeconds must be a whole number ≥ 0' });
  }
  const started = startedAt ? new Date(startedAt) : new Date();
  if (Number.isNaN(started.getTime())) return res.status(400).json({ error: 'startedAt must be a date' });

  const { error } = await supabase.from('dial_attempts').insert({
    user_id: req.profile.id,
    rule_id: ruleId || null,
    prospect_id: prospectId,
    phone: phone || null,
    outcome,
    talk_seconds: talkSeconds ?? null,
    started_at: started.toISOString(),
    note: note || null,
  });
  if (error) throw error;
  res.status(201).json({ ok: true });
});

module.exports = router;
