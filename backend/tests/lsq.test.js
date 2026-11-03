jest.mock('../config/lsq', () => ({ lsqClient: { get: jest.fn() }, lsqUrl: p => p }));
const { lsqClient } = require('../config/lsq');
const { findActiveLsqUserByEmail, accessFor } = require('../services/lsq_users');
const { isDialerList } = require('../services/lsq_lists');

test('isDialerList: dynamic and named "Dialer – …" with any dash', () => {
  expect(isDialerList({ ListType: 'dynamic', ListName: 'Dialer – Fresh leads' })).toBe(true);
  expect(isDialerList({ ListType: 'dynamic', ListName: 'dialer - callback' })).toBe(true);
  expect(isDialerList({ ListType: 'static', ListName: 'Dialer – Fresh leads' })).toBe(false);
  expect(isDialerList({ ListType: 'dynamic', ListName: 'Old Dialer – x' })).toBe(false);
  expect(isDialerList({ ListType: 'dynamic', ListName: 'Dialers backup' })).toBe(false);
});

test('accessFor: managers and admins manage; everyone else is an associate', () => {
  expect(accessFor('Sales_Manager')).toBe('manager');
  expect(accessFor('Administrator')).toBe('manager');
  expect(accessFor('Sales_User')).toBe('associate');
});

test('findActiveLsqUserByEmail: case-insensitive, skips inactive users', async () => {
  lsqClient.get.mockResolvedValue({ data: [
    { ID: 'old', EmailAddress: 'a@kalvium.com', StatusCode: 1 },
    { ID: 'new', EmailAddress: 'A@Kalvium.com', StatusCode: 0 },
  ] });
  expect((await findActiveLsqUserByEmail(' a@kalvium.com ')).ID).toBe('new');
  expect(await findActiveLsqUserByEmail('nobody@kalvium.com')).toBeNull();
  expect(await findActiveLsqUserByEmail('')).toBeNull();
});
