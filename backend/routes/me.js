const express = require('express');
const { requireAuth } = require('../middleware/auth');
const lsqKeys = require('../services/lsq_keys');
const { salesOpen } = require('./setup');

const router = express.Router();

// Who am I: called by the app and dashboard right after Supabase login. Links the LSQ user on first call.
router.get('/', requireAuth, async (req, res) => {
  const { id, email, name, lsq_user_id, access, groups, tlGroups, mode } = req.profile;
  res.json({
    id, email, name, lsqUserId: lsq_user_id, access, groups, tlGroups,
    mode: mode || null,
    hasKey: await lsqKeys.hasKeys(id),
    suggestedMode: (groups || []).includes('Team HR') ? 'hr' : 'sales',
    salesOpen: salesOpen(),
  });
});

module.exports = router;
