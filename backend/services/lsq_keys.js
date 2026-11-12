const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../config/supabase');
const { lsqClient, lsqParams } = require('../config/lsq');

// Personal LSQ keys: encrypted at rest, never logged, never returned by any endpoint.
function secret() {
  const key = Buffer.from(process.env.LSQ_KEYS_SECRET || '', 'base64');
  if (key.length !== 32) throw new Error('LSQ_KEYS_SECRET must be 32 bytes, base64 (openssl rand -base64 32)');
  return key;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(stored) {
  const raw = Buffer.from(stored, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// In headers, not the URL, so keys can't end up in access logs.
const keyHeaders = ({ accessKey, secretKey }) => ({ 'x-LSQ-AccessKey': accessKey, 'x-LSQ-SecretKey': secretKey });

// true/false for keys LSQ accepts or refuses; anything else (LSQ down) throws, so a good key isn't reported as wrong.
async function keysWork(keys) {
  try {
    await lsqClient.get(`${lsqParams().host}/LeadManagement.svc/LeadsMetaData.Get`, { headers: keyHeaders(keys) });
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) return false;
    throw err;
  }
}

// Decrypted keys for a few minutes, so each save skips a database read. Forgotten when the person saves new keys.
const KEY_CACHE_MS = 10 * 60 * 1000;
const _keyCache = new Map(); // user id -> { keys, expires }

async function saveKeys(userId, { accessKey, secretKey }) {
  _keyCache.delete(userId);
  const { error } = await supabase.from('user_lsq_keys').upsert({
    user_id: userId,
    access_key_enc: encrypt(accessKey),
    secret_key_enc: encrypt(secretKey),
    verified_at: null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function hasKeys(userId) {
  const { data, error } = await supabase.from('user_lsq_keys').select('user_id').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return !!data;
}

// { accessKey, secretKey, verified } or null.
async function getKeys(userId) {
  const hit = _keyCache.get(userId);
  if (hit && hit.expires > Date.now() && !(hit.keys && !hit.keys.verified)) return hit.keys; // unverified: re-read until verified
  const { data, error } = await supabase.from('user_lsq_keys')
    .select('access_key_enc, secret_key_enc, verified_at').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const keys = { accessKey: decrypt(data.access_key_enc), secretKey: decrypt(data.secret_key_enc), verified: !!data.verified_at };
  _keyCache.set(userId, { keys, expires: Date.now() + KEY_CACHE_MS });
  return keys;
}

async function markVerified(userId) {
  const { error } = await supabase.from('user_lsq_keys').update({ verified_at: new Date().toISOString() }).eq('user_id', userId);
  if (error) throw error;
}

module.exports = { encrypt, decrypt, keyHeaders, keysWork, saveKeys, hasKeys, getKeys, markVerified };
