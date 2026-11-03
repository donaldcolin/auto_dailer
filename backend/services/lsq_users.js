const { lsqClient, lsqUrl } = require('../config/lsq');

const CACHE_MS = 10 * 60 * 1000;
let _cache = { users: null, expires: 0 };

// One Users.Get call returns every LSQ user (~700), so cache it instead of one call per login.
async function fetchLsqUsers() {
  if (_cache.users && _cache.expires > Date.now()) return _cache.users;
  const { data } = await lsqClient.get(lsqUrl('UserManagement.svc/Users.Get'));
  _cache = { users: data, expires: Date.now() + CACHE_MS };
  return data;
}

// Active (StatusCode 0) LSQ user with this email, or null.
async function findActiveLsqUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const users = await fetchLsqUsers();
  return users.find(u => u.StatusCode === 0 && String(u.EmailAddress).toLowerCase() === target) || null;
}

// shortcut: TLs are Sales_Users in LSQ, so they map to 'associate' here; step 2 adds TL detection.
function accessFor(lsqRole) {
  return ['Sales_Manager', 'Administrator'].includes(lsqRole) ? 'manager' : 'associate';
}

module.exports = { fetchLsqUsers, findActiveLsqUserByEmail, accessFor };
