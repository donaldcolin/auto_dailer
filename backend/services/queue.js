const supabase = require('../config/supabase');
const { lsqClient, lsqUrl } = require('../config/lsq');
const { activeRuleFor, istNow } = require('./rules');

const LIST_CACHE_MS = 5 * 60 * 1000;
const PAGE_SIZE = 200;
const COLUMNS = 'ProspectID,FirstName,LastName,Phone,Mobile,ProspectStage,OwnerId';

// shortcut: per-process cache, fine with one backend instance; move to a shared store if it's scaled out.
const _lists = new Map(); // listId -> { leads, expires } or { pending }

const toLead = row => {
  const p = Object.fromEntries((row.LeadPropertyList || []).map(x => [x.Attribute, x.Value]));
  return {
    prospectId: p.ProspectID,
    name: [p.FirstName, p.LastName].filter(Boolean).join(' '),
    phone: p.Mobile || p.Phone || null,
    stage: p.ProspectStage,
    ownerId: p.OwnerId,
  };
};

// Every lead in a dynamic List. Page 1 asks LSQ to recalculate the List; later pages reuse that result.
async function readList(listId) {
  const leads = [];
  for (let page = 1; ; page++) {
    const { data } = await lsqClient.post(lsqUrl('LeadManagement.svc/Leads/Retrieve/BySearchParameter'), {
      SearchParameters: { ListId: listId, RetrieveBehaviour: page === 1 ? '1' : '0' },
      Columns: { Include_CSV: COLUMNS },
      Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data.Leads || [];
    leads.push(...rows.map(toLead));
    if (rows.length < PAGE_SIZE || leads.length >= data.RecordCount) return leads;
  }
}

// One LSQ read per List every few minutes serves the whole team; concurrent callers share it.
async function getListLeads(listId, now = Date.now()) {
  const hit = _lists.get(listId);
  if (hit?.leads && hit.expires > now) return hit.leads;
  if (hit?.pending) return hit.pending;
  const pending = readList(listId)
    .then(leads => { _lists.set(listId, { leads, expires: Date.now() + LIST_CACHE_MS }); return leads; })
    .catch(err => { _lists.delete(listId); throw err; });
  _lists.set(listId, { pending });
  return pending;
}

// The caller's own leads with a phone number, minus the ones already dialed.
function ownQueue(leads, ownerId, dialedIds) {
  return leads.filter(l => l.ownerId === ownerId && l.phone && !dialedIds.has(l.prospectId));
}

async function getQueue(profile, now = new Date()) {
  const rule = await activeRuleFor(profile, now);
  if (!rule) return { rule: null, leads: [] };

  const [leads, { data: dialed, error }] = await Promise.all([
    getListLeads(rule.list_id),
    supabase.from('dial_attempts').select('prospect_id')
      .eq('user_id', profile.id).eq('rule_id', rule.id).gte('started_at', istNow(now).midnightIso),
  ]);
  if (error) throw error;

  return {
    rule: { id: rule.id, listName: rule.list_name, startTime: String(rule.start_time).slice(0, 5) },
    leads: ownQueue(leads, profile.lsq_user_id, new Set(dialed.map(d => d.prospect_id)))
      .map(({ ownerId, ...lead }) => lead),
  };
}

module.exports = { getQueue, getListLeads, ownQueue, readList };
