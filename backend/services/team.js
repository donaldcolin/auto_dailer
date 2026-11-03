const supabase = require('../config/supabase');
const { fetchLsqUsers } = require('./lsq_users');

const fullName = u => [u.FirstName, u.LastName].filter(Boolean).join(' ');

// Groups this LSQ user leads, per the team_leads table managers maintain.
async function getTlGroups(lsqUserId) {
  const { data, error } = await supabase.from('team_leads').select('group_name').eq('lsq_user_id', lsqUserId);
  if (error) throw error;
  return data.map(r => r.group_name);
}

// A Sales_User becomes a TL once a manager assigns them a group. Manager access always wins.
async function withTeamLead(profile) {
  const tlGroups = await getTlGroups(profile.lsq_user_id);
  const access = profile.access === 'associate' && tlGroups.length ? 'tl' : profile.access;
  return { ...profile, access, tlGroups };
}

// Every sales group with at least one active LSQ user.
async function allGroups() {
  const users = await fetchLsqUsers();
  return [...new Set(users.filter(u => u.StatusCode === 0).flatMap(u => u.MemberOfGroups || []))].sort();
}

async function manageableGroups(profile) {
  return profile.access === 'manager' ? allGroups() : profile.tlGroups || [];
}

// Groups the caller manages, each with its TL and active associates.
async function getTeam(profile) {
  const [groups, users, { data: leads, error }] = await Promise.all([
    manageableGroups(profile),
    fetchLsqUsers(),
    supabase.from('team_leads').select('group_name, lsq_user_id'),
  ]);
  if (error) throw error;
  const active = users.filter(u => u.StatusCode === 0);
  const byId = Object.fromEntries(active.map(u => [u.ID, u]));
  const tlOf = Object.fromEntries(leads.map(l => [l.group_name, l.lsq_user_id]));

  return groups.map(group => {
    const tl = byId[tlOf[group]];
    return {
      group,
      tl: tl ? { lsqUserId: tl.ID, name: fullName(tl) } : null,
      associates: active
        .filter(u => (u.MemberOfGroups || []).includes(group))
        .map(u => ({ lsqUserId: u.ID, name: fullName(u) })),
    };
  });
}

// Manager only (checked by the route). The TL must be an active LSQ user; they needn't be in the group.
async function setTeamLead(group, lsqUserId, setBy) {
  if (!(await allGroups()).includes(group)) return { error: `Unknown group: ${group}` };
  const users = await fetchLsqUsers();
  if (!users.some(u => u.ID === lsqUserId && u.StatusCode === 0)) return { error: 'No active LSQ user with that id' };
  const { error } = await supabase.from('team_leads').upsert({
    group_name: group, lsq_user_id: lsqUserId, set_by: setBy, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return {};
}

async function removeTeamLead(group) {
  const { error } = await supabase.from('team_leads').delete().eq('group_name', group);
  if (error) throw error;
}

module.exports = { getTlGroups, withTeamLead, manageableGroups, getTeam, setTeamLead, removeTeamLead };
