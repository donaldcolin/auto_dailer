const { lsqClient, lsqUrl } = require('../config/lsq');

// TLs name dialer Lists "Dialer – …" (any dash). Static Lists never update, so only dynamic ones count.
const DIALER_NAME = /^dialer\s*[–—-]/i;

function isDialerList(list) {
  return list.ListType === 'dynamic' && DIALER_NAME.test(list.ListName || '');
}

// Lists.Get returns at most 500 per page (the org has ~2,350), so filter by name on LSQ's side.
// Kept a minute: every queue load with a view checks its id against these.
let _lists = null;
async function getDialerLists() {
  if (_lists && _lists.expires > Date.now()) return _lists.value;
  const { data } = await lsqClient.get(`${lsqUrl('LeadManagement.svc/Lists.Get')}&SearchText=Dialer`);
  const value = data.filter(isDialerList).map(l => ({
    id: l.ListId,
    name: l.ListName,
    description: l.ListDescription,
    memberCount: l.MemberCount,
  }));
  _lists = { value, expires: Date.now() + 60 * 1000 };
  return value;
}

module.exports = { getDialerLists, isDialerList };
