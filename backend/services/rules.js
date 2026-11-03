const supabase = require('../config/supabase');
const { fetchLsqUsers } = require('./lsq_users');
const { getDialerLists } = require('./lsq_lists');
const { manageableGroups } = require('./team');

// Rules run on India time: start_time and weekdays are IST.
const IST = 'Asia/Kolkata';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function istNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: IST, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  return {
    day: WEEKDAYS.indexOf(parts.weekday),
    time: `${parts.hour}:${parts.minute}`,
    midnightIso: `${parts.year}-${parts.month}-${parts.day}T00:00:00+05:30`,
  };
}

const hhmm = t => String(t).slice(0, 5); // Postgres returns "16:00:00"

/**
 * The associate's rule right now: today's weekday, latest start_time that has passed.
 * At the same start time, a rule for the associate beats one for their group.
 */
function pickActiveRule(rules, profile, now = new Date()) {
  const { day, time } = istNow(now);
  const mine = rules.filter(r =>
    ((r.target_type === 'user' && r.target_id === profile.lsq_user_id) ||
     (r.target_type === 'group' && (profile.groups || []).includes(r.target_id))) &&
    r.days.includes(day) && hhmm(r.start_time) <= time
  );
  mine.sort((a, b) =>
    hhmm(b.start_time).localeCompare(hhmm(a.start_time)) ||
    (a.target_type === 'user' ? -1 : 0) - (b.target_type === 'user' ? -1 : 0)
  );
  return mine[0] || null;
}

async function activeRuleFor(profile, now) {
  const targetIds = [profile.lsq_user_id, ...(profile.groups || [])];
  const { data, error } = await supabase.from('rules').select('*').in('target_id', targetIds);
  if (error) throw error;
  return pickActiveRule(data, profile, now);
}

/**
 * Checks a rule body against what the caller may manage. Returns { rule } or { error }.
 * A TL can target their groups and the associates in them; a manager can target anyone.
 */
async function validateRule(body, profile) {
  const { targetType, targetId, listId, startTime, days } = body || {};
  if (!['user', 'group'].includes(targetType) || !targetId) return { error: 'targetType (user|group) and targetId are required' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime || '')) return { error: 'startTime must be HH:MM (24h, IST)' };
  if (!Array.isArray(days) || !days.length || !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return { error: 'days must be a non-empty list of 0–6 (0 = Sunday)' };
  }

  const groups = await manageableGroups(profile);
  if (targetType === 'group' && !groups.includes(targetId)) return { error: `You don't manage the group ${targetId}` };
  if (targetType === 'user') {
    const user = (await fetchLsqUsers()).find(u => u.ID === targetId && u.StatusCode === 0);
    if (!user) return { error: 'No active LSQ user with that id' };
    if (profile.access !== 'manager' && !(user.MemberOfGroups || []).some(g => groups.includes(g))) {
      return { error: "That associate isn't in a group you manage" };
    }
  }

  const list = (await getDialerLists()).find(l => l.id === listId);
  if (!list) return { error: 'listId must be a dynamic LSQ List named "Dialer – …"' };

  return {
    rule: {
      target_type: targetType, target_id: targetId, list_id: list.id, list_name: list.name,
      start_time: startTime, days: [...new Set(days)].sort(), created_by: profile.id,
      updated_at: new Date().toISOString(),
    },
  };
}

// Rules the caller may see and change: their groups and the associates in them.
async function rulesInScope(profile) {
  const groups = await manageableGroups(profile);
  const users = await fetchLsqUsers();
  const userIds = new Set(users.filter(u => (u.MemberOfGroups || []).some(g => groups.includes(g))).map(u => u.ID));
  const { data, error } = await supabase.from('rules').select('*').order('start_time');
  if (error) throw error;
  if (profile.access === 'manager') return data;
  return data.filter(r => (r.target_type === 'group' ? groups.includes(r.target_id) : userIds.has(r.target_id)));
}

module.exports = { istNow, pickActiveRule, activeRuleFor, validateRule, rulesInScope };
