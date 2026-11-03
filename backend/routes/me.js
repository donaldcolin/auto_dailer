const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Who am I: called by the app and dashboard right after Supabase login. Links the LSQ user on first call.
router.get('/', requireAuth, (req, res) => {
  const { id, email, name, lsq_user_id, access, groups, tlGroups } = req.profile;
  res.json({ id, email, name, lsqUserId: lsq_user_id, access, groups, tlGroups });
});

module.exports = router;
