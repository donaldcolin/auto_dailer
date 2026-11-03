jest.mock('../config/supabase', () => ({}));
jest.mock('../config/lsq', () => ({ lsqClient: { post: jest.fn() }, lsqUrl: p => p }));
const { lsqClient } = require('../config/lsq');
const { ownQueue, getListLeads } = require('../services/queue');

const row = (id, owner, mobile = '9000000000') => ({ LeadPropertyList: [
  { Attribute: 'ProspectID', Value: id }, { Attribute: 'OwnerId', Value: owner }, { Attribute: 'Mobile', Value: mobile },
] });

test('ownQueue keeps the caller\'s leads with a phone, minus ones already dialed', () => {
  const leads = [
    { prospectId: 'p1', ownerId: 'L1', phone: '1' },
    { prospectId: 'p2', ownerId: 'L2', phone: '2' },
    { prospectId: 'p3', ownerId: 'L1', phone: null },
    { prospectId: 'p4', ownerId: 'L1', phone: '4' },
  ];
  expect(ownQueue(leads, 'L1', new Set(['p4'])).map(l => l.prospectId)).toEqual(['p1']);
});

test('getListLeads pages through the List once and shares it with concurrent callers', async () => {
  const page1 = Array.from({ length: 200 }, (_, i) => row(`a${i}`, 'L1'));
  lsqClient.post
    .mockResolvedValueOnce({ data: { RecordCount: 201, Leads: page1 } })
    .mockResolvedValueOnce({ data: { RecordCount: 201, Leads: [row('last', 'L2')] } });

  const [a, b] = await Promise.all([getListLeads('list1'), getListLeads('list1')]);
  expect(a).toHaveLength(201);
  expect(b).toBe(a);
  expect(lsqClient.post).toHaveBeenCalledTimes(2);
  expect(lsqClient.post.mock.calls[0][1].SearchParameters.RetrieveBehaviour).toBe('1');
  expect(lsqClient.post.mock.calls[1][1].SearchParameters.RetrieveBehaviour).toBe('0');

  await getListLeads('list1'); // still cached
  expect(lsqClient.post).toHaveBeenCalledTimes(2);
});
