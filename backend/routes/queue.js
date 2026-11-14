const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getQueue, viewCounts } = require('../services/queue');
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
// ?counts=1 adds each one's lead count; slower the first time (a person's tasks), so the app asks for names first.
router.get('/views', requireAuth, async (req, res) => {
  const list = [{ id: 'own', name: 'My leads' }, ...(req.profile.mode === 'sales' ? listViews() : [])];
  if (req.query.counts !== '1' || list.length === 1) return res.json({ views: list });
  try {
    const counts = await viewCounts(req.profile);
    res.json({ views: list.map(v => ({ ...v, count: counts[v.id] })) });
  } catch (err) {
    console.error('[views]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not count your leads' });
  }
});

module.exports = router;
