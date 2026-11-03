const express = require('express');
const { requireAuth, requireAccess } = require('../middleware/auth');
const { getDialerLists } = require('../services/lsq_lists');

const router = express.Router();

// Dynamic LSQ Lists named "Dialer – …", for the rule picker in the dashboard.
router.get('/', requireAuth, requireAccess(['tl', 'manager']), async (req, res) => {
  try {
    res.json(await getDialerLists());
  } catch (err) {
    console.error('[lists]', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not load Lists from LeadSquared' });
  }
});

module.exports = router;
