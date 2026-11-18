// The queue as the dialer works through it: leads already marked or waiting to send drop out, and leads skipped on
// this phone go to the back, the earliest skip first, whatever order a reload brought (the server may not have the
// skip yet). `skipped` maps a prospect id to when it was skipped.
export function pendingLeads(leads, { handled, skipped, waiting }) {
  const open = leads.filter((l) => !handled.has(l.prospectId) && !waiting.has(l.prospectId));
  return [
    ...open.filter((l) => !skipped.has(l.prospectId)),
    ...open.filter((l) => skipped.has(l.prospectId)).sort((a, b) => skipped.get(a.prospectId) - skipped.get(b.prospectId)),
  ];
}
