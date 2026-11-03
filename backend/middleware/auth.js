const supabase = require('../config/supabase');
const { getProfile } = require('../services/profile');

const USER_CACHE_TTL_MS = 60 * 1000;
const _userCache = new Map(); // token -> { user, expires }

/**
 * Verifies a Supabase session token with Supabase Auth (works for both legacy HS256
 * and asymmetric signing keys). Results are cached briefly so UI polling stays cheap.
 */
async function verifySupabaseToken(token) {
  const now = Date.now();
  const hit = _userCache.get(token);
  if (hit && hit.expires > now) return hit.user;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  if (_userCache.size > 1000) _userCache.clear();
  _userCache.set(token, { user: data.user, expires: now + USER_CACHE_TTL_MS });
  return data.user;
}

// Supabase login + a linked, active LSQ user. Sets req.profile (row from the users table).
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const user = await verifySupabaseToken(authHeader.slice(7).trim());
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
    const profile = await getProfile(user);
    if (!profile) {
      return res.status(403).json({ error: `No active LeadSquared user has the email ${user.email}` });
    }
    req.profile = profile;
    return next();
  } catch (err) {
    console.error('[auth]', err.message);
    return res.status(500).json({ error: 'Could not verify your login' });
  }
}

// access comes from LSQ: 'associate' | 'tl' | 'manager'
function requireAccess(allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.profile?.access)) {
      return res.status(403).json({ error: `Forbidden: requires one of [${allowed.join(', ')}]` });
    }
    next();
  };
}

module.exports = { requireAuth, requireAccess };
