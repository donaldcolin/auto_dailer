const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAccess } = require('../middleware/auth');
const { validateRule, rulesInScope } = require('../services/rules');

const router = express.Router();
router.use(requireAuth, requireAccess(['tl', 'manager']));

router.get('/', async (req, res) => {
  res.json(await rulesInScope(req.profile));
});

router.post('/', async (req, res) => {
  const { rule, error } = await validateRule(req.body, req.profile);
  if (error) return res.status(400).json({ error });
  const { data, error: dbError } = await supabase.from('rules').insert(rule).select().single();
  if (dbError) throw dbError;
  res.status(201).json(data);
});

// Edit or delete only a rule that's in the caller's scope, and (for edits) keep it in scope.
async function findInScope(req, res) {
  const rule = (await rulesInScope(req.profile)).find(r => r.id === req.params.id);
  if (!rule) res.status(404).json({ error: 'Rule not found' });
  return rule;
}

router.put('/:id', async (req, res) => {
  if (!(await findInScope(req, res))) return;
  const { rule, error } = await validateRule(req.body, req.profile);
  if (error) return res.status(400).json({ error });
  const { data, error: dbError } = await supabase.from('rules').update(rule).eq('id', req.params.id).select().single();
  if (dbError) throw dbError;
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  if (!(await findInScope(req, res))) return;
  const { error } = await supabase.from('rules').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ ok: true });
});

module.exports = router;
