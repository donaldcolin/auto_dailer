const { lsqClient, lsqUrl } = require('../config/lsq');

// TLs push leads to the dialer by adding the custom LSQ activity "Auto Dialer" to them.
const PUSH_EVENT = 283;
// shortcut: only pushes from the last 7 days count; add a "Status" field check if older pushes must stay queued.
const WINDOW_DAYS = 7;
const PAGE_SIZE = 200;

const lsqTime = d => d.toISOString().replace('T', ' ').slice(0, 19); // LSQ wants "YYYY-MM-DD HH:mm:ss", UTC
const fromLsqTime = s => new Date(`${s.replace(' ', 'T')}Z`).toISOString();

// Every Auto Dialer activity in the window: who pushed which lead, when.
async function fetchPushes(now = new Date()) {
  const pushes = [];
  const from = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 60 * 1000);
  for (let page = 1; ; page++) {
    const { data } = await lsqClient.post(lsqUrl('ProspectActivity.svc/RetrieveRecentlyModified'), {
      Parameter: { FromDate: lsqTime(from), ToDate: lsqTime(to), ActivityEvent: PUSH_EVENT },
      Paging: { PageIndex: page, PageSize: PAGE_SIZE },
    });
    const rows = data.ProspectActivities || [];
    pushes.push(...rows.map(a => ({ activityId: a.Id, prospectId: a.RelatedProspectId, pushedAt: fromLsqTime(a.CreatedOn) })));
    if (rows.length < PAGE_SIZE) return pushes;
  }
}

/**
 * Pushed leads still to call for one associate, oldest push first.
 * shortcut: a push goes to the lead's owner; reading an "Assign To" field needs a per-lead fetch for non-owned leads.
 * @param pushes     from fetchPushes
 * @param ownedLeads the associate's leads (unfiltered by stage: a TL may push a closed lead on purpose)
 * @param attempts   the associate's dial_attempts rows ({ prospect_id, started_at }) for those leads
 */
function pendingPushes(pushes, ownedLeads, attempts) {
  const owned = new Map(ownedLeads.filter(l => l.phone).map(l => [l.prospectId, l]));
  const latest = new Map(); // a lead pushed twice counts once, from its latest push
  for (const p of pushes) {
    if (!owned.has(p.prospectId)) continue;
    const seen = latest.get(p.prospectId);
    if (!seen || p.pushedAt > seen.pushedAt) latest.set(p.prospectId, p);
  }
  const dialedAfterPush = p => attempts.some(a => a.prospect_id === p.prospectId && new Date(a.started_at) >= new Date(p.pushedAt));
  return [...latest.values()]
    .filter(p => !dialedAfterPush(p))
    .sort((a, b) => a.pushedAt.localeCompare(b.pushedAt))
    .map(p => ({ ...owned.get(p.prospectId), pushed: true, pushedAt: p.pushedAt }));
}

module.exports = { fetchPushes, pendingPushes, PUSH_EVENT };
