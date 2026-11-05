const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const activity = require('../services/activity');
const lsqKeys = require('../services/lsq_keys');

const router = express.Router();

const OUTCOMES = ['no_answer', 'connected', 'skipped'];

const KEY_REJECTED = { code: 'lsq_key_rejected', error: 'LeadSquared refused your key, so this activity wasn\'t saved. Update your LeadSquared key and tap Save again.' };

// The first post with new keys: if LSQ credits someone else, they pasted a colleague's keys. Never blocks the caller.
function verifyCreator(profile, keys, activityId) {
  if (keys.verified) return;
  activity.activityCreatorEmail(activityId).then(email => {
    if (email && email.toLowerCase() === (profile.email || '').toLowerCase()) return lsqKeys.markVerified(profile.id);
    console.error(`[activity] keys of ${profile.email} post as ${email}`);
  }).catch(err => console.error('[activity] creator check failed:', err.message));
}

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
  if (!event) return res.status(409).json({ code: 'setup_required', error: 'Finish setup first.' });
  if (outcome !== 'skipped') {
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'activity is required' });
    let lsq;
    try {
      lsq = activity.toLsqFields(await activity.getForm(event), values);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    // No fallback to the org key: that would credit this person's call to someone else.
    const keys = await lsqKeys.getKeys(req.profile.id);
    if (!keys) return res.status(422).json(KEY_REJECTED);
    try {
      const activityId = await activity.postActivity({ keys, event, prospectId, ownerId: req.profile.lsq_user_id, at: started, ...lsq });
      verifyCreator(req.profile, keys, activityId);
    } catch (e) {
      console.error('[activity]', e.response?.status, JSON.stringify(e.response?.data) || e.message);
      if (e.response?.status === 401) return res.status(422).json(KEY_REJECTED);
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
  res.status(201).json({ ok: true });
});

module.exports = router;
