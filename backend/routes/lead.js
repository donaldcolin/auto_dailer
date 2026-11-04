const express = require('express');
const { requireAuth } = require('../middleware/auth');
const queue = require('../services/queue');
const history = require('../services/history');

const router = express.Router();

// Recent LSQ activity on one lead, for the call screen. Associates only see their own leads.
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    if (req.profile.access === 'associate') {
      const [lead] = await queue.readLeadsByIds([req.params.id]);
      if (!lead || lead.ownerId !== req.profile.lsq_user_id) return res.status(404).json({ error: 'Lead not found' });
    }
    res.json({ history: await history.leadHistory(req.params.id) });
  } catch (err) {
    console.error('[history]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not load this lead\'s activity' });
  }
});

module.exports = router;
