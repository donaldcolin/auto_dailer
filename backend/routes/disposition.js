const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const activity = require('../services/activity');

const router = express.Router();

// shortcut: placeholder outcomes for teams without an LSQ activity form yet (sales); 'connected' = marked through the form.
const OUTCOMES = ['no_answer', 'connected', 'interested', 'not_interested', 'call_back', 'wrong_number', 'skipped'];

// One row per dial. The call itself reaches LSQ through Callyzer; the caller's own marking goes in as their team's
// LSQ activity (`activity` in the body), posted before the row so a failed post can be retried without losing it.
router.post('/', requireAuth, async (req, res) => {
  const { prospectId, phone, outcome, talkSeconds, startedAt, ruleId, note, activity: values } = req.body || {};
  if (!prospectId || typeof prospectId !== 'string') return res.status(400).json({ error: 'prospectId is required' });
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
  if (talkSeconds != null && !(Number.isInteger(talkSeconds) && talkSeconds >= 0)) {
    return res.status(400).json({ error: 'talkSeconds must be a whole number ≥ 0' });
  }
  const started = startedAt ? new Date(startedAt) : new Date();
  if (Number.isNaN(started.getTime())) return res.status(400).json({ error: 'startedAt must be a date' });

  const event = activity.activityEventFor(req.profile);
  let activityId = null;
  if (event && outcome !== 'skipped') {
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'activity is required' });
    let lsq;
    try {
      lsq = activity.toLsqFields(await activity.getForm(event), values);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    try {
      activityId = await activity.postActivity({ event, prospectId, ownerId: req.profile.lsq_user_id, at: started, ...lsq });
    } catch (e) {
      console.error('[activity]', e.response?.status, JSON.stringify(e.response?.data) || e.message);
      return res.status(502).json({ error: `LeadSquared didn't save the activity: ${e.response?.data?.ExceptionMessage || e.message}` });
    }
  }

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
  res.status(201).json({ ok: true, activityId });
});

module.exports = router;
