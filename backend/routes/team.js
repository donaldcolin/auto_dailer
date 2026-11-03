const express = require('express');
const { requireAuth, requireAccess } = require('../middleware/auth');
const { getTeam, setTeamLead, removeTeamLead } = require('../services/team');

const router = express.Router();

// The caller's groups (all groups for a manager), each with its TL and associates.
router.get('/', requireAuth, requireAccess(['tl', 'manager']), async (req, res) => {
  res.json(await getTeam(req.profile));
});

// Managers choose who leads each group: LSQ doesn't record TLs.
router.put('/:group/lead', requireAuth, requireAccess(['manager']), async (req, res) => {
  const { lsqUserId } = req.body || {};
  if (!lsqUserId) return res.status(400).json({ error: 'lsqUserId is required' });
  const { error } = await setTeamLead(req.params.group, lsqUserId, req.profile.id);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});

router.delete('/:group/lead', requireAuth, requireAccess(['manager']), async (req, res) => {
  await removeTeamLead(req.params.group);
  res.json({ ok: true });
});

module.exports = router;
