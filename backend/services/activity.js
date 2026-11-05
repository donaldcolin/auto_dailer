const { lsqClient, lsqUrl, lsqParams } = require('../config/lsq');
const { keyHeaders } = require('./lsq_keys');

// The LSQ activity each mode marks after a call, and how the app lays out its form.
const EVENT_BY_MODE = { hr: 263, sales: 218 };
const FORMS = {
  263: { // HR Activity
    // Shown first; the rest sits under "More fields". Picked from what HR filled in 59 real entries (2026-11-04).
    short: ['mx_Custom_1', 'mx_Custom_3', 'mx_Custom_2', 'mx_Custom_9', 'mx_Custom_10', 'mx_Custom_23', 'mx_Custom_44', 'mx_Custom_50', 'ActivityEvent_Note', 'mx_Custom_4'],
    // Carried over from the last saved activity on the phone, so the reason screen needs one tap.
    sticky: ['mx_Custom_2', 'mx_Custom_9', 'mx_Custom_10'],
    defaults: { mx_Custom_2: 'Screening Round', mx_Custom_9: 'Sales', mx_Custom_10: 'BDA / BDT' },
  },
  218: { // BDA Activity. Sales stays closed (SALES_READY) until an LSQ admin makes "Spoke with" optional.
    short: ['mx_Custom_1', 'Status', 'mx_Custom_4', 'mx_Custom_31', 'mx_Custom_3', 'ActivityEvent_Note', 'mx_Custom_26'],
    sticky: ['mx_Custom_1'],
    defaults: { mx_Custom_1: 'Qualification Call' },
    alwaysBlank: ['mx_Custom_37'], // LSQ fills "JEE" into this one when it's left out
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
  const cfg = FORMS[type.ActivityEvent] || { short: [], sticky: [], defaults: {} };
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
    short: cfg.short,
    sticky: cfg.sticky,
    defaults: cfg.defaults,
    connected: connected && reason ? { schema: connected.schema, reason: reason.schema } : null,
    alwaysBlank: cfg.alwaysBlank || [],
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
function toLsqFields(form, input) {
  const bad = msg => Object.assign(new Error(msg), { status: 400 });
  const byName = new Map(form.fields.map(f => [f.schema, f]));
  let note = '';
  const fields = [];
  for (const [schema, raw] of Object.entries(input || {})) {
    const f = byName.get(schema);
    if (!f) throw bad(`Unknown field ${schema}`);
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
  const missing = form.fields.find(f => f.required && f.schema !== NOTE && !fields.some(x => x.SchemaName === f.schema));
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

// Who LSQ says created an activity; catches someone who pasted a colleague's keys.
async function activityCreatorEmail(activityId) {
  const { data } = await lsqClient.get(`${lsqUrl('ProspectActivity.svc/GetActivityDetails')}&activityId=${encodeURIComponent(activityId)}`);
  return data.CreatedByEmail || null;
}

module.exports = { FORMS, activityEventFor, getForm, toForm, toLsqFields, postActivity, activityCreatorEmail };
