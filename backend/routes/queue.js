const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getQueue } = require('../services/queue');

const router = express.Router();

// The caller's leads to dial now: all their own leads, or a TL rule's List. Any login can dial.
// ?fresh=1 re-reads LSQ instead of using the caches (the app's "Refresh leads").
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await getQueue(req.profile, new Date(), { fresh: req.query.fresh === '1' }));
  } catch (err) {
    console.error('[queue]', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not build your queue' });
  }
});

module.exports = router;
