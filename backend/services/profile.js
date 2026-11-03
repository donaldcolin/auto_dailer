const supabase = require('../config/supabase');
const { findActiveLsqUserByEmail, accessFor } = require('./lsq_users');

const RESYNC_MS = 24 * 60 * 60 * 1000;

/**
 * Our users row for a Supabase auth user, linked to their LSQ user by email.
 * Re-reads role and groups from LSQ once a day. Returns null when no active LSQ user has that email.
 */
async function getProfile(authUser) {
  const { data: row, error } = await supabase.from('users').select('*').eq('id', authUser.id).maybeSingle();
  if (error) throw error;
  if (row && Date.now() - new Date(row.synced_at).getTime() < RESYNC_MS) return row;

  const lsq = await findActiveLsqUserByEmail(authUser.email);
  if (!lsq) return null;

  const fresh = {
    id: authUser.id,
    email: authUser.email,
    name: [lsq.FirstName, lsq.LastName].filter(Boolean).join(' '),
    lsq_user_id: lsq.ID,
    lsq_role: lsq.Role,
    access: accessFor(lsq.Role),
    groups: lsq.MemberOfGroups || [],
    synced_at: new Date().toISOString(),
  };
  const { data, error: upsertError } = await supabase.from('users').upsert(fresh).select().single();
  if (upsertError) throw upsertError;
  return data;
}

module.exports = { getProfile };
