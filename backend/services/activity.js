const { lsqClient, lsqUrl, lsqParams } = require('../config/lsq');
const { keyHeaders } = require('./lsq_keys');

// The LSQ activity each mode marks after a call, and how the app lays out its form.
const EVENT_BY_MODE = { hr: 284, sales: 218 };

// HR form rules. `when`: every field must have that value, or any value for `true`.
const PICKED = { mx_Custom_7: true, mx_Custom_10: true, mx_Custom_2: true }; // Function, Role, Activity Type
const SCREENING = ['mx_Custom_20', 'mx_Custom_14', 'mx_Custom_15', 'mx_Custom_16', 'mx_Custom_17', 'mx_Custom_18', 'mx_Custom_22', 'mx_Custom_43', 'mx_Custom_8', 'mx_Custom_50', 'mx_Custom_49'];
// A round: connected → "Proceed with …"; Proceed = Yes → that round's fields.
const round = (type, proceed, show) => [
  { when: { ...PICKED, mx_Custom_2: type, mx_Custom_1: 'Yes' }, show: [proceed] },
  { when: { ...PICKED, mx_Custom_2: type, mx_Custom_1: 'Yes', [proceed]: 'Yes' }, show },
];
// Same logic as `shown` in app/ActivityForm.js: a field some rule names shows only while one of those rules matches.
function shown(rules, schema, values) {
  const own = (rules || []).filter(r => r.show.includes(schema));
  return !own.length || own.some(r => Object.entries(r.when).every(([k, v]) => (v === true ? !!values[k] : values[k] === v)));
}
const FORMS = {
  284: { // Auto Dialer - HR activity: HR Activity's fields, but Function is mx_Custom_7 and Task Status mx_Custom_8 here
    // Same sections as "HR Activity form V1" in LSQ; `rules` shows each round's fields the way that form's rules do.
    sections: [
      ['Lead Qualification', ['mx_Custom_7', 'mx_Custom_10', 'mx_Custom_2', 'mx_Custom_1', 'mx_Custom_3', 'mx_Custom_4',
        'mx_Custom_23', 'mx_Custom_37', 'mx_Custom_38', 'mx_Custom_39', 'mx_Custom_40', 'mx_Custom_41', 'mx_Custom_42', 'ActivityEvent_Note', 'mx_Custom_44']],
      ['Screening Check Points', SCREENING],
      ['Round 1 Interview', ['mx_Custom_5', 'mx_Custom_9', 'mx_Custom_6', 'mx_Custom_45']],
      ['Round 2 Interview', ['mx_Custom_24', 'mx_Custom_25', 'mx_Custom_26', 'mx_Custom_46']],
      ['Round 3 Interview', ['mx_Custom_27', 'mx_Custom_28', 'mx_Custom_29', 'mx_Custom_47']],
      ['Round 4 Interview', ['mx_Custom_30', 'mx_Custom_31', 'mx_Custom_32', 'mx_Custom_48']],
      ['Culture Fit', ['mx_Custom_33', 'mx_Custom_34']],
      ['Final Interview Status', ['mx_Custom_11', 'mx_Custom_35', 'mx_Custom_36']],
    ],
    rules: [
      // LSQ also wants Function, Role and Type here; left out so the one-tap reason is never dropped.
      { when: { mx_Custom_1: 'No' }, show: ['mx_Custom_3', 'mx_Custom_4'] },
      { when: { ...PICKED, mx_Custom_2: 'Screening Round', mx_Custom_1: 'Yes' }, show: ['mx_Custom_23'] },
      { when: { ...PICKED, mx_Custom_2: 'Screening Round', mx_Custom_1: 'Yes', mx_Custom_23: 'Yes' }, show: ['mx_Custom_44'] },
      { when: { mx_Custom_2: 'Screening Round', mx_Custom_1: 'Yes', mx_Custom_23: 'Yes', mx_Custom_44: 'Selected' }, show: SCREENING },
      // Seen in LSQ for R1 and R2 (2026-11-12); R3, R4, Culture fit and Final follow the same pattern, not yet checked.
      ...round('Round 1 Interview', 'mx_Custom_37', ['mx_Custom_5', 'mx_Custom_9', 'mx_Custom_6', 'mx_Custom_45']),
      ...round('Round 2 Interview', 'mx_Custom_38', ['mx_Custom_24', 'mx_Custom_25', 'mx_Custom_26', 'mx_Custom_46']),
      ...round('Round 3 Interview', 'mx_Custom_39', ['mx_Custom_27', 'mx_Custom_28', 'mx_Custom_29', 'mx_Custom_47']),
      ...round('Round 4 Interview', 'mx_Custom_40', ['mx_Custom_30', 'mx_Custom_31', 'mx_Custom_32', 'mx_Custom_48']),
      ...round('Culture fit', 'mx_Custom_41', ['mx_Custom_33', 'mx_Custom_34']),
      ...round('Final Interview status', 'mx_Custom_42', ['mx_Custom_11', 'mx_Custom_35', 'mx_Custom_36']),
    ],
    more: false, // LSQ's form has nothing beyond these
    // Carried over from the last saved activity on the phone, so the reason screen needs one tap.
    sticky: ['mx_Custom_2', 'mx_Custom_7', 'mx_Custom_10'],
    defaults: { mx_Custom_2: 'Screening Round', mx_Custom_7: 'Sales', mx_Custom_10: 'BDA / BDT' },
  },
  // HR Activity, used until 2026-11-07. Kept so calls marked before then still show in Recent activity.
  263: {
    sections: [
      ['Lead Qualification', ['mx_Custom_9', 'mx_Custom_10', 'mx_Custom_2', 'mx_Custom_1', 'mx_Custom_3', 'mx_Custom_23', 'ActivityEvent_Note', 'mx_Custom_44', 'mx_Custom_4']],
    ],
    sticky: [],
    defaults: {},
  },
  218: { // BDA Activity. Sales stays closed (SALES_READY) until an LSQ admin makes "Spoke with" optional.
    sections: [[null, ['mx_Custom_1', 'Status', 'mx_Custom_4', 'mx_Custom_31', 'mx_Custom_3', 'ActivityEvent_Note', 'mx_Custom_26']]],
    sticky: ['mx_Custom_1'],
    defaults: { mx_Custom_1: 'Qualification Call' },
    alwaysBlank: ['mx_Custom_37'], // LSQ fills "JEE" into this one when it's left out
    // shortcut: "Spoke with" is mandatory in LSQ even when nobody answered, and it has no NA option, so unanswered calls
    // record a placeholder that skews any report on it; remove once an LSQ admin makes the field optional.
    notConnected: { mx_Custom_31: 'Student' },
  },
};
const NOTE = 'ActivityEvent_Note'; // a field in LSQ's metadata, but Create takes it as ActivityNote
const HIDDEN = ['Owner']; // always the caller, set here
const CACHE_MS = 60 * 60 * 1000;

// null until the person has finished setup.
const activityEventFor = profile => EVENT_BY_MODE[profile.mode] || null;

const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };
const values = opts => (opts || []).map(o => o.Value).filter(Boolean);

// LSQ field metadata → the shape the app renders. Dependent dropdowns get { parentValue: [options] }.
function toForm(type) {
  const cfg = FORMS[type.ActivityEvent] || { sections: [], sticky: [], defaults: {} };
  const fields = type.Fields
    .filter(f => f.ShowInForm && !HIDDEN.includes(f.SchemaName))
    .sort((a, b) => a.Sequence - b.Sequence)
    .map(f => {
      const dep = parseJson(f.DependentOptionSet);
      return {
        schema: f.SchemaName,
        label: f.DisplayName.trim(),
        type: /Dropdown/.test(f.DataType) ? 'dropdown' : f.DataType === 'DateTime' ? 'datetime' : f.DataType === 'Number' ? 'number' : 'text',
        required: f.IsMandatory,
        parent: f.ParentField || null,
        options: dep ? null : values(parseJson(f.OptionSet)),
        dependent: dep ? Object.fromEntries(dep.map(d => [d.Parent, values(d.Options)])) : null,
      };
    });
  const connected = fields.find(f => /call connected/i.test(f.label));
  const reason = connected && fields.find(f => f.parent === connected.schema && f.dependent?.No);
  return {
    event: type.ActivityEvent,
    name: type.DisplayName,
    fields,
    sections: cfg.sections,
    sticky: cfg.sticky,
    defaults: cfg.defaults,
    connected: connected && reason ? { schema: connected.schema, reason: reason.schema } : null,
    alwaysBlank: cfg.alwaysBlank || [],
    notConnected: cfg.notConnected || {},
    rules: cfg.rules || [],
    more: cfg.more !== false,
  };
}

let cache = null;
async function getForm(event) {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const { data } = await lsqClient.get(lsqUrl('ProspectActivity.svc/ActivityTypes.Get'));
    cache = { at: Date.now(), types: data };
  }
  const type = cache.types.find(t => t.ActivityEvent === event);
  if (!type) throw new Error(`LSQ has no activity ${event}`);
  return toForm(type);
}

const lsqTime = d => d.toISOString().replace('T', ' ').slice(0, 19); // "YYYY-MM-DD HH:mm:ss", UTC

/**
 * Checks the app's values against the form and returns LSQ's Create fields.
 * Throws an Error with `status = 400` for anything LSQ would reject or silently store wrong.
 */
function toLsqFields(form, rawInput) {
  const bad = msg => Object.assign(new Error(msg), { status: 400 });
  const unanswered = form.connected && rawInput?.[form.connected.schema] === 'No';
  const input = unanswered ? { ...form.notConnected, ...rawInput } : rawInput;
  const byName = new Map(form.fields.map(f => [f.schema, f]));
  let note = '';
  const fields = [];
  for (const [schema, raw] of Object.entries(input || {})) {
    const f = byName.get(schema);
    if (!f) throw bad(`Unknown field ${schema}`);
    if (!shown(form.rules, schema, input)) continue; // left over from another round: LSQ's form wouldn't send it
    const value = raw == null ? '' : String(raw).trim();
    if (!value) continue;
    if (schema === NOTE) { note = value; continue; }
    if (f.type === 'dropdown') {
      const allowed = f.dependent ? f.dependent[input[f.parent]] || [] : f.options;
      if (!allowed.includes(value)) throw bad(`${f.label}: "${value}" is not an option`);
    }
    if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) throw bad(`${f.label} must be a number`);
    if (f.type === 'datetime') {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw bad(`${f.label} must be a date`);
      fields.push({ SchemaName: schema, Value: lsqTime(d) });
      continue;
    }
    fields.push({ SchemaName: schema, Value: value });
  }
  const missing = form.fields.find(f => f.required && f.schema !== NOTE && shown(form.rules, f.schema, input) && !fields.some(x => x.SchemaName === f.schema));
  if (missing) throw bad(`${missing.label} is required`);
  for (const schema of form.alwaysBlank || []) fields.push({ SchemaName: schema, Value: '' });
  return { fields, note };
}

// Posts the activity on the lead with the caller's own keys, so LSQ shows them as Created By. Returns LSQ's activity id.
async function postActivity({ keys, event, prospectId, ownerId, at, fields, note }) {
  const { data } = await lsqClient.post(`${lsqParams().host}/ProspectActivity.svc/Create`, {
    RelatedProspectId: prospectId,
    ActivityEvent: event,
    ActivityNote: note,
    ActivityDateTime: lsqTime(at),
    Fields: [...fields, { SchemaName: 'Owner', Value: ownerId }],
  }, { headers: keyHeaders(keys) });
  return data.Message.Id;
}

// Whether the lead already has this activity at exactly this time (the dialer posts ActivityDateTime = call start).
async function alreadyPosted({ event, prospectId, at }) {
  const { data } = await lsqClient.post(`${lsqUrl('ProspectActivity.svc/Retrieve')}&leadId=${encodeURIComponent(prospectId)}`, {
    Parameter: { FromDate: '', ToDate: '', IncludeCustomActivity: 1, ActivityEvent: event },
    Paging: { Offset: '0', RowCount: '10' },
    Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
  });
  return (data.ProspectActivities || []).some(a => a.EventCode === event && a.CreatedOn === lsqTime(at));
}

// Who LSQ says created an activity; catches someone who pasted a colleague's keys.
async function activityCreatorEmail(activityId) {
  const { data } = await lsqClient.get(`${lsqUrl('ProspectActivity.svc/GetActivityDetails')}&activityId=${encodeURIComponent(activityId)}`);
  return data.CreatedByEmail || null;
}

module.exports = { FORMS, shown, alreadyPosted, activityEventFor, getForm, toForm, toLsqFields, postActivity, activityCreatorEmail };
