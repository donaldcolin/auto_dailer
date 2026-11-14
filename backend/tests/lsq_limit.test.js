const { isLeadRead, lsqClient } = require('../config/lsq');

test('lead reads are told apart from other LSQ calls', () => {
  for (const u of ['h/LeadManagement.svc/Leads.Get?a', 'h/LeadManagement.svc/Leads.GetById?id=1', 'h/LeadManagement.svc/Leads/Retrieve/BySearchParameter']) expect(isLeadRead(u)).toBe(true);
  for (const u of ['h/LeadManagement.svc/LeadsMetaData.Get', 'h/LeadManagement.svc/Lists.Get', 'h/ProspectActivity.svc/Create']) expect(isLeadRead(u)).toBe(false);
});

// LSQ allows 15 lead reads per 5 s (measured 2026-11-14): 3 start at once, the 4th a window later.
test('lead reads start 3 per 1.1 s', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const starts = [];
  lsqClient.defaults.adapter = async c => { starts.push(Date.now()); return { data: {}, status: 200, headers: {}, config: c }; };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => lsqClient.get('h/LeadManagement.svc/Leads.GetById?id=1')));
  const d = starts.map(t => t - t0);
  expect(d[2]).toBeLessThan(300);
  expect(d[3]).toBeGreaterThanOrEqual(1000);
});
