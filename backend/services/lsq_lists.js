const { lsqClient, lsqUrl } = require('../config/lsq');

// TLs name dialer Lists "Dialer – …" (any dash). Static Lists never update, so only dynamic ones count.
const DIALER_NAME = /^dialer\s*[–—-]/i;

function isDialerList(list) {
  return list.ListType === 'dynamic' && DIALER_NAME.test(list.ListName || '');
}

// Lists.Get returns at most 500 per page (the org has ~2,350), so filter by name on LSQ's side.
async function getDialerLists() {
  const { data } = await lsqClient.get(`${lsqUrl('LeadManagement.svc/Lists.Get')}&SearchText=Dialer`);
  return data.filter(isDialerList).map(l => ({
    id: l.ListId,
    name: l.ListName,
    description: l.ListDescription,
    memberCount: l.MemberCount,
  }));
}

module.exports = { getDialerLists, isDialerList };
