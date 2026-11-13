const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getQueue, getViews } = require('../services/queue');

const router = express.Router();

// The caller's leads to dial now: all their own leads, or a TL rule's List. Any login can dial.
// ?fresh=1 re-reads LSQ instead of using the caches (the app's "Refresh leads").
router.get('/', requireAuth, async (req, res) => {
  try {
    const view = typeof req.query.view === 'string' && req.query.view !== 'own' ? req.query.view : null;
    res.json(await getQueue(req.profile, new Date(), { fresh: req.query.fresh === '1', view }));
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ error: err.message, code: err.code });
    // A personal key LSQ refuses (401) also means the person must update it.
    if (err.response?.status === 401) return res.status(422).json({ error: 'LeadSquared refused your key. Update it in ☰ → Settings.', code: 'lsq_key_rejected' });
    console.error('[queue]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not build your queue' });
  }
});

// The views to pick from: "My leads" plus each "Dialer – …" List, in the Smart Views' order.
router.get('/views', requireAuth, async (req, res) => {
  try {
    res.json({ views: [{ id: 'own', name: 'My leads' }, ...(await getViews())] });
  } catch (err) {
    console.error('[views]', err.response?.data?.ExceptionMessage || err.message);
    res.status(502).json({ error: 'Could not load views' });
  }
});

module.exports = router;
