const express = require('express');
const { requireAuth } = require('../middleware/auth');
const queue = require('../services/queue');
const history = require('../services/history');

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

module.exports = router;
