const { lsqClient, lsqUrl } = require('../config/lsq');
const activity = require('./activity');
const { istTime } = require('./queue');

const PHONE_CALLS = new Set([21, 22]); // inbound / outbound phone call activities (Callyzer)
// Not worth reading before a call (Donald, 2026-11-04): SMS sent, dynamic form submissions, Auto Dialer pushes.
const HIDDEN = new Set([203, 97, 283]);

// One line about a team-form activity (HR Activity…) from the values LSQ lists with it, labelled by the form.
function formSummary(fields, form) {
  const parts = [];
  for (const schema of form.sections[0][1]) {
    const v = fields[schema];
    if (!v || form.sticky.includes(schema) || schema === 'ActivityEvent_Note') continue;
    if (schema === form.connected?.schema) { parts.push(v === 'No' ? 'Not connected' : v === 'Yes' ? 'Connected' : v); continue; }
    if (schema === form.connected?.reason) { parts.push(v); continue; }
    const f = form.fields.find(x => x.schema === schema);
    if (f) parts.push(`${f.label}: ${f.type === 'datetime' ? istTime(v) : v}`);
  }
  return parts.join(', ');
}

/**
 * A lead's latest LSQ activities, newest first, as plain lines for the call screen:
 * { at, what, detail, note }. One LSQ call; team-form values come labelled from the form's metadata.
 */
async function leadHistory(leadId, limit = 6) {
  // Read extra rows so hidden kinds don't leave the list short.
  const { data } = await lsqClient.post(`${lsqUrl('ProspectActivity.svc/Retrieve')}&leadId=${encodeURIComponent(leadId)}`, {
    Parameter: { FromDate: '', ToDate: '', IncludeCustomActivity: 1 },
    Paging: { Offset: '0', RowCount: String(limit * 3) },
    Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
  });
  const rows = (data.ProspectActivities || []).filter(a => !HIDDEN.has(a.EventCode)).slice(0, limit);
  const forms = {};
  for (const e of new Set(rows.map(a => a.EventCode))) if (activity.FORMS[e]) forms[e] = await activity.getForm(e);

  return rows.map(a => {
    const d = Object.fromEntries((a.Data || []).map(x => [x.Key, x.Value]));
    const fields = a.ActivityFields || {};
    let detail = '';
    if (forms[a.EventCode]) detail = formSummary(fields, forms[a.EventCode]);
    else if (PHONE_CALLS.has(a.EventCode)) detail = d.CallType || '';
    return {
      at: istTime(a.CreatedOn),
      what: a.EventCode === 22 ? 'Outgoing call' : a.EventCode === 21 ? 'Incoming call' : a.EventName,
      detail,
      note: forms[a.EventCode] ? (fields.ActivityEvent_Note || '') : '',
    };
  });
}

module.exports = { leadHistory, formSummary };
