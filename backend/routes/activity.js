const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { activityEventFor, getForm } = require('../services/activity');

const router = express.Router();

// The post-call activity form for the caller, from LSQ's own metadata. { form: null } = no LSQ activity yet (sales).
router.get('/', requireAuth, async (req, res) => {
  const event = activityEventFor(req.profile);
  res.json({ form: event ? await getForm(event) : null });
});

module.exports = router;
