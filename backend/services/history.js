const { lsqClient, lsqUrl } = require('../config/lsq');
const activity = require('./activity');
const { istTime } = require('./queue');
const supabase = require('../config/supabase');

const PHONE_CALLS = new Set([21, 22]); // inbound / outbound phone call activities (Callyzer), with Duration in seconds
// Not worth reading before a call (Donald, 2026-11-04): SMS sent, dynamic form submissions, Auto Dialer pushes.
const HIDDEN = new Set([203, 97, 283]);
const PAIR_MS = 15 * 60 * 1000; // a marked activity and Callyzer's log of the same call are minutes apart at most

const utc = s => new Date(`${String(s).replace(' ', 'T')}Z`).getTime();
const spoke = sec => (sec >= 60 ? `Spoke ${Math.floor(sec / 60)}m ${sec % 60}s` : `Spoke ${sec}s`);

// "Today, 7:22 pm" / "Yesterday, 4:02 pm" / "10 Nov, 7:11 pm", in IST.
function when(s, now = Date.now()) {
  const day = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const t = istTime(s);
  const time = t.split(', ').pop();
  if (day(utc(s)) === day(now)) return `Today, ${time}`;
  if (day(utc(s)) === day(now - 86400000)) return `Yesterday, ${time}`;
  return t;
}

// What a marked team-form activity (HR / BDA) says, in a few words: the activity type and any status
// ("Screening Round · Selected"), and the follow-up. The rest of the form is left for LSQ.
function formSummary(fields, form) {
  const label = re => form.fields.find(f => re.test(f.label) && fields[f.schema]);
  const type = label(/activity type/i);
  const parts = type ? [fields[type.schema]] : [];
  for (const f of form.fields) {
    const v = fields[f.schema];
    if (v && /status/i.test(f.label) && f.schema !== 'Status') parts.push(v);
  }
  const follow = label(/follow up/i);
  if (follow) parts.push(`Follow up ${istTime(fields[follow.schema])}`);
  return parts.join(' · ');
}

/**
 * A lead's latest LSQ activities, newest first, for the call screen: { at, kind, what, detail, note }.
 * what: the activity's name (the heading); detail: the outcome. kind: 'spoke' | 'missed' | 'other'. A marked HR/BDA activity and Callyzer's log of the same call become one line:
 * "Spoke 2m 4s" with the form's outcome, or just the reason it didn't connect ("Did not pick").
 */
async function leadHistory(leadId, limit = 6, now = Date.now()) {
  // Read extra rows: hidden kinds and calls merged into their marked activity don't count.
  const { data } = await lsqClient.post(`${lsqUrl('ProspectActivity.svc/Retrieve')}&leadId=${encodeURIComponent(leadId)}`, {
    Parameter: { FromDate: '', ToDate: '', IncludeCustomActivity: 1 },
    Paging: { Offset: '0', RowCount: String(limit * 4) },
    Sorting: { ColumnName: 'CreatedOn', Direction: '1' },
  });
  const rows = (data.ProspectActivities || []).filter(a => !HIDDEN.has(a.EventCode));
  const forms = {};
  for (const e of new Set(rows.map(a => a.EventCode))) if (activity.FORMS[e]) forms[e] = await activity.getForm(e);

  const data_ = a => Object.fromEntries((a.Data || []).map(x => [x.Key, x.Value]));
  const calls = rows.filter(a => PHONE_CALLS.has(a.EventCode)).map(a => ({ a, at: utc(a.CreatedOn), sec: Number(data_(a).Duration) || 0 }));

  // First pass: each marked activity claims Callyzer's log of the same call (nearest in time; connected for a
  // connected mark, not connected for a reason), so one call is one line whichever was written first.
  const pair = new Map(); // form activity -> its call
  const claimed = new Set();
  for (const a of rows) {
    const form = forms[a.EventCode];
    if (!form?.connected) continue;
    const missed = (a.ActivityFields || {})[form.connected.schema] === 'No';
    const t = utc(a.CreatedOn);
    const call = calls.filter(c => !claimed.has(c.a) && (missed ? c.sec === 0 : c.sec > 0) && Math.abs(c.at - t) < PAIR_MS)
      .sort((x, y) => Math.abs(x.at - t) - Math.abs(y.at - t))[0];
    if (call) { claimed.add(call.a); pair.set(a, call); }
  }

  // The dialer's own record of each call it marked: talk time by the second it started, which is the
  // activity's CreatedOn (the dialer posts ActivityDateTime = the call's start).
  const { data: dials } = await supabase.from('dial_attempts').select('started_at, talk_seconds')
    .eq('prospect_id', leadId).eq('outcome', 'connected').order('started_at', { ascending: false }).limit(limit * 2);
  const talk = new Map((dials || []).map(d => [new Date(d.started_at).toISOString().slice(0, 19), d.talk_seconds]));

  const out = [];
  const seen = new Set();
  for (const a of rows) {
    if (claimed.has(a)) continue;
    const key = `${a.EventCode} ${a.CreatedOn}`; // the same save posted twice (a retry after a lost reply) shows once
    if (seen.has(key)) continue;
    seen.add(key);
    const at = when(a.CreatedOn, now);
    const form = forms[a.EventCode];
    if (form) {
      const fields = a.ActivityFields || {};
      const note = fields.ActivityEvent_Note || '';
      if (form.connected && fields[form.connected.schema] === 'No') {
        out.push({ at, kind: 'missed', what: a.EventName, detail: fields[form.connected.reason] || 'Did not pick', note });
      } else {
        const sec = talk.get(String(a.CreatedOn).replace(' ', 'T').slice(0, 19)) || pair.get(a)?.sec;
        out.push({ at, kind: 'spoke', what: a.EventName, detail: [sec ? spoke(sec) : 'Connected', formSummary(fields, form)].filter(Boolean).join(' · '), note });
      }
    } else if (PHONE_CALLS.has(a.EventCode)) {
      const sec = Number(data_(a).Duration) || 0;
      out.push(sec > 0
        ? { at, kind: 'spoke', what: a.EventCode === 21 ? 'Incoming call' : 'Outgoing call', detail: spoke(sec), note: '' }
        : { at, kind: 'missed', what: a.EventCode === 21 ? 'Incoming call' : 'Outgoing call', detail: a.EventCode === 21 ? 'Missed their call' : 'Did not pick', note: '' });
    } else if (a.EventCode === 3002) {
      const d = data_(a);
      out.push({ at, kind: 'other', what: 'Stage changed', detail: [d.PreviousStage, d.CurrentStage].filter(Boolean).join(' → '), note: '' });
    } else {
      out.push({ at, kind: 'other', what: a.EventName, detail: '', note: '' });
    }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { leadHistory, formSummary, when };
