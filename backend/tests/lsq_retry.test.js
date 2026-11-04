const { AxiosError } = require('axios');
const { lsqClient } = require('../config/lsq');

// Fake transport: answers 429 `fails` times, then 200.
function fakeLsq(fails) {
  let calls = 0;
  lsqClient.defaults.adapter = async (config) => {
    calls++;
    if (calls <= fails) {
      const response = { status: 429, data: { ExceptionMessage: 'API calls exceeded the limit of 15 in 5 second(s)' }, headers: {}, config };
      throw new AxiosError('429', 'ERR_BAD_REQUEST', config, null, response);
    }
    return { status: 200, data: { ok: true }, headers: {}, config };
  };
  return () => calls;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a 429 from LSQ is retried after its window instead of failing', async () => {
  const calls = fakeLsq(1);
  const p = lsqClient.get('https://lsq.test/x');
  await jest.advanceTimersByTimeAsync(6000);
  await expect(p).resolves.toMatchObject({ data: { ok: true } });
  expect(calls()).toBe(2);
});

test('gives up after two retries', async () => {
  const calls = fakeLsq(5);
  const p = lsqClient.get('https://lsq.test/x');
  const assertion = expect(p).rejects.toMatchObject({ response: { status: 429 } });
  await jest.advanceTimersByTimeAsync(20000);
  await assertion;
  expect(calls()).toBe(3);
});
