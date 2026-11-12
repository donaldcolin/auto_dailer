process.env.LSQ_KEYS_SECRET = Buffer.alloc(32, 7).toString('base64');
const mockRow = { data: null };
const mockReads = jest.fn();
const mockQuery = { select: () => mockQuery, eq: () => mockQuery, maybeSingle: async () => { mockReads(); return { data: mockRow.data, error: null }; }, upsert: async () => ({ error: null }) };
jest.mock('../config/supabase', () => ({ from: () => mockQuery }));
const { encrypt, decrypt, getKeys, saveKeys } = require('../services/lsq_keys');

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

test('verified keys are read from the database once, and again after new keys are saved', async () => {
  mockRow.data = { access_key_enc: encrypt('ak'), secret_key_enc: encrypt('sk'), verified_at: '2026-11-12' };
  expect(await getKeys('u9')).toEqual({ accessKey: 'ak', secretKey: 'sk', verified: true });
  await getKeys('u9');
  expect(mockReads).toHaveBeenCalledTimes(1);
  await saveKeys('u9', { accessKey: 'ak2', secretKey: 'sk2' });
  await getKeys('u9');
  expect(mockReads).toHaveBeenCalledTimes(2);
});
