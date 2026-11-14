const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getQueue } = require('../services/queue');
const { listViews } = require('../services/views');

const router = express.Router();

// The caller's leads to dial now: all their own leads, or a TL rule's List. Any login can dial.
// ?fresh=1 re-reads LSQ instead of using the caches (the app's "Refresh leads").
router.get('/', requireAuth, async (req, res) => {
  try {
    const view = typeof req.query.view === 'string' && req.query.view !== 'own' ? req.query.view : null;
    res.json(await getQueue(req.profile, new Date(), { fresh: req.query.fresh === '1', view }));
  } catch (err) {
    console.error('[queue]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not build your queue' });
  }
});

// The views to pick from: "My leads" plus, for sales, the Smart View tabs in LSQ's order (services/views.js).
router.get('/views', requireAuth, (req, res) => {
  res.json({ views: [{ id: 'own', name: 'My leads' }, ...(req.profile.mode === 'sales' ? listViews() : [])] });
});

module.exports = router;
