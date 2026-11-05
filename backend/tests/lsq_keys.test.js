process.env.LSQ_KEYS_SECRET = Buffer.alloc(32, 7).toString('base64');
jest.mock('../config/supabase', () => ({}));
const { encrypt, decrypt } = require('../services/lsq_keys');

test('keys round-trip, and the stored form is not the key', () => {
  const stored = encrypt('u$rsecret');
  expect(stored).not.toContain('u$rsecret');
  expect(decrypt(stored)).toBe('u$rsecret');
  expect(encrypt('u$rsecret')).not.toBe(stored); // fresh IV each time
});

test('tampered data is refused', () => {
  const raw = Buffer.from(encrypt('u$rsecret'), 'base64');
  raw[raw.length - 1] ^= 1;
  expect(() => decrypt(raw.toString('base64'))).toThrow();
});

test('a missing or short secret fails loudly', () => {
  const good = process.env.LSQ_KEYS_SECRET;
  process.env.LSQ_KEYS_SECRET = 'c2hvcnQ=';
  expect(() => encrypt('x')).toThrow(/LSQ_KEYS_SECRET/);
  process.env.LSQ_KEYS_SECRET = good;
});
