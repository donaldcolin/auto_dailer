const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getQueue } = require('../services/queue');

const router = express.Router();

// The caller's leads for their rule right now. TLs and managers can dial too, so any login works.
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await getQueue(req.profile));
  } catch (err) {
    console.error('[queue]', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not build your queue' });
  }
});

module.exports = router;
