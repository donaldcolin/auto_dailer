const mockPost = jest.fn();
jest.mock('../config/lsq', () => ({ lsqClient: { post: (...a) => mockPost(...a), get: jest.fn() }, lsqUrl: p => p, lsqParams: () => ({ host: 'https://lsq' }) }));
jest.mock('../config/supabase', () => ({}));
const { FORMS, shown, activityEventFor, toForm, toLsqFields, postActivity } = require('../services/activity');

// A cut-down HR activity (284) as ActivityTypes.Get returns it: option sets are JSON strings.
const opts = vs => JSON.stringify(vs.map(Value => ({ Value })));
const field = (SchemaName, DisplayName, DataType, Sequence, extra = {}) =>
  ({ SchemaName, DisplayName, DataType, Sequence, ShowInForm: true, IsMandatory: false, ParentField: '', OptionSet: '', DependentOptionSet: '', ...extra });
const TYPE = {
  ActivityEvent: 284,
  DisplayName: 'Auto Dialer - HR activity',
  Fields: [
    field('mx_Custom_3', 'Reason of Call failure ', 'SearchableDropdown', 3, {
      ParentField: 'mx_Custom_1', DependentOptionSet: JSON.stringify([{ Parent: 'No', Options: [{ Value: 'Did not pick' }, { Value: 'Switched Off' }] }]),
    }),
    field('ActivityEvent_Note', 'Notes', 'String', 0),
    field('Owner', 'Owner', 'ActiveUsers', 1),
    field('mx_Custom_1', 'Call Connected', 'SearchableDropdown', 1, { OptionSet: opts(['', 'Yes', 'No']) }),
    field('mx_Custom_4', 'Follow Up date', 'DateTime', 4),
    field('mx_Custom_20', 'Qualification Completion Year', 'Number', 20),
    field('mx_Custom_99', 'Hidden', 'String', 99, { ShowInForm: false }),
  ],
};
const form = { ...toForm(TYPE), rules: [] }; // checks values only; the HR rules have their own tests

test('the mode picks the activity: HR 284, Sales 286, nothing before setup', () => {
  expect(activityEventFor({ mode: 'hr' })).toBe(284);
  expect(activityEventFor({ mode: 'sales' })).toBe(286);
  expect(activityEventFor({ groups: ['Team HR'] })).toBeNull();
});

test('fields LSQ would auto-fill go out blank (BDA entrance prep)', () => {
  const out = toLsqFields({ ...form, alwaysBlank: ['mx_Custom_37'] }, { mx_Custom_1: 'No' });
  expect(out.fields).toContainEqual({ SchemaName: 'mx_Custom_37', Value: '' });
});

test('form: LSQ order, no Owner or hidden fields, dependent options by parent, call-connected pair found', () => {
  expect(form.fields.map(f => f.schema)).toEqual(['ActivityEvent_Note', 'mx_Custom_1', 'mx_Custom_3', 'mx_Custom_4', 'mx_Custom_20']);
  expect(form.fields[1]).toMatchObject({ type: 'dropdown', options: ['Yes', 'No'], label: 'Call Connected' });
  expect(form.fields[2]).toMatchObject({ label: 'Reason of Call failure', parent: 'mx_Custom_1', dependent: { No: ['Did not pick', 'Switched Off'] } });
  expect(form.connected).toEqual({ schema: 'mx_Custom_1', reason: 'mx_Custom_3' });
  expect(form.defaults).toMatchObject({ mx_Custom_2: 'Screening Round' });
});

test('values: note split out, blanks dropped, dates sent as LSQ UTC', () => {
  const out = toLsqFields(form, { mx_Custom_1: 'No', mx_Custom_3: 'Did not pick', ActivityEvent_Note: ' dnp ', mx_Custom_20: '', mx_Custom_4: '2026-11-05T04:30:00.000Z' });
  expect(out.note).toBe('dnp');
  expect(out.fields).toEqual([
    { SchemaName: 'mx_Custom_1', Value: 'No' },
    { SchemaName: 'mx_Custom_3', Value: 'Did not pick' },
    { SchemaName: 'mx_Custom_4', Value: '2026-11-05 04:30:00' },
  ]);
});

test('values LSQ would reject or store wrong are refused', () => {
  expect(() => toLsqFields(form, { mx_Custom_1: 'Maybe' })).toThrow(/not an option/);
  expect(() => toLsqFields(form, { mx_Custom_1: 'Yes', mx_Custom_3: 'Did not pick' })).toThrow(/not an option/); // reason only under No
  expect(() => toLsqFields(form, { Owner: 'someone' })).toThrow(/Unknown field/);
  expect(() => toLsqFields(form, { mx_Custom_20: '20x6' })).toThrow(/number/);
  expect(() => toLsqFields(form, { mx_Custom_4: 'soon' })).toThrow(/date/);
  const strict = { ...form, fields: form.fields.map(f => f.schema === 'mx_Custom_1' ? { ...f, required: true } : f) };
  expect(() => toLsqFields(strict, {})).toThrow(/Call Connected is required/);
});

test('post: with the caller\'s own keys, on the lead, owned by the caller, at the call time', async () => {
  mockPost.mockResolvedValue({ data: { Status: 'Success', Message: { Id: 'act-1' } } });
  const id = await postActivity({ keys: { accessKey: 'ak', secretKey: 'sk' }, event: 263, prospectId: 'p1', ownerId: 'L1', at: new Date('2026-11-04T09:00:00Z'), fields: [{ SchemaName: 'mx_Custom_1', Value: 'No' }], note: '' });
  expect(id).toBe('act-1');
  expect(mockPost.mock.calls[0][0]).toBe('https://lsq/ProspectActivity.svc/Create'); // no keys in the URL
  expect(mockPost.mock.calls[0][2].headers).toEqual({ 'x-LSQ-AccessKey': 'ak', 'x-LSQ-SecretKey': 'sk' });
  expect(mockPost.mock.calls[0][1]).toEqual({
    RelatedProspectId: 'p1', ActivityEvent: 263, ActivityNote: '', ActivityDateTime: '2026-11-04 09:00:00',
    Fields: [{ SchemaName: 'mx_Custom_1', Value: 'No' }, { SchemaName: 'Owner', Value: 'L1' }],
  });
});

test('HR form follows LSQ order and sections, each field once', () => {
  const [first, second] = FORMS[284].sections;
  expect(first[0]).toBe('Lead Qualification');
  expect(first[1].slice(0, 4)).toEqual(['mx_Custom_7', 'mx_Custom_10', 'mx_Custom_2', 'mx_Custom_1']);
  expect(second[0]).toBe('Screening Check Points');
  const all = FORMS[284].sections.flatMap(([, s]) => s);
  expect(new Set(all).size).toBe(all.length);
});

test("HR rules show each round the way LSQ's form does", () => {
  const { rules } = FORMS[284];
  const base = { mx_Custom_7: 'Sales', mx_Custom_10: 'BDA / BDT' };
  const screening = { ...base, mx_Custom_2: 'Screening Round', mx_Custom_1: 'Yes' };
  expect(shown(rules, 'mx_Custom_23', screening)).toBe(true); // Proceed with Screening checks
  expect(shown(rules, 'mx_Custom_44', screening)).toBe(false); // Screening Status waits for Proceed = Yes
  expect(shown(rules, 'mx_Custom_44', { ...screening, mx_Custom_23: 'Yes' })).toBe(true);
  expect(shown(rules, 'mx_Custom_14', { ...screening, mx_Custom_23: 'Yes', mx_Custom_44: 'Selected' })).toBe(true);
  expect(shown(rules, 'mx_Custom_14', { ...screening, mx_Custom_23: 'Yes', mx_Custom_44: 'Rejected' })).toBe(false);
  const r1 = { ...base, mx_Custom_2: 'Round 1 Interview', mx_Custom_1: 'Yes' };
  expect(shown(rules, 'mx_Custom_23', r1)).toBe(false);
  expect(shown(rules, 'mx_Custom_37', r1)).toBe(true);
  expect(shown(rules, 'mx_Custom_5', r1)).toBe(false);
  expect(shown(rules, 'mx_Custom_5', { ...r1, mx_Custom_37: 'Yes' })).toBe(true);
  expect(shown(rules, 'mx_Custom_4', { ...r1, mx_Custom_1: 'No' })).toBe(true); // Follow Up date only when not connected
  expect(shown(rules, 'mx_Custom_4', r1)).toBe(false);
  expect(shown(rules, 'ActivityEvent_Note', {})).toBe(true); // no rule names it: always shown
});

test('values a rule hides are not sent, and hidden required fields are not asked for', () => {
  const ruled = {
    ...form,
    rules: [{ when: { mx_Custom_1: 'Yes' }, show: ['mx_Custom_20'] }],
    fields: form.fields.map(f => (f.schema === 'mx_Custom_20' ? { ...f, required: true } : f)),
  };
  expect(toLsqFields(ruled, { mx_Custom_1: 'No', mx_Custom_20: '2024' }).fields.map(f => f.SchemaName)).toEqual(['mx_Custom_1']);
  expect(() => toLsqFields(ruled, { mx_Custom_1: 'Yes' })).toThrow('Qualification Completion Year is required');
});

test('unanswered calls get the placeholder for a mandatory field; connected calls and a real choice do not', () => {
  const strict = {
    ...form,
    connected: { schema: 'mx_Custom_1', reason: 'mx_Custom_3' },
    notConnected: { spoke: 'Student' },
    fields: [...form.fields, { schema: 'spoke', label: 'Spoke with', type: 'dropdown', required: true, options: ['Student', 'Father'] }],
  };
  const spoke = out => out.fields.find(f => f.SchemaName === 'spoke')?.Value;
  expect(spoke(toLsqFields(strict, { mx_Custom_1: 'No' }))).toBe('Student');
  expect(spoke(toLsqFields(strict, { mx_Custom_1: 'No', spoke: 'Father' }))).toBe('Father');
  expect(() => toLsqFields(strict, { mx_Custom_1: 'Yes' })).toThrow('Spoke with is required');
});

describe("Sales (286) rules follow ARM Activity V5 on 218", () => {
  const r = FORMS[286].rules;
  const sees = (values, schema) => shown(r, schema, values);
  const STUDENT = ['mx_Custom_4', 'mx_Custom_5', 'mx_Custom_6', 'mx_Custom_35', 'mx_Custom_56', 'mx_Custom_29', 'mx_Custom_58', 'mx_Custom_25'];
  const APPOINTMENT = ['mx_Custom_50', 'mx_Custom_8', 'mx_Custom_21', 'mx_Custom_28', 'mx_Custom_9'];

  test.each(['Qualification Call', 'Appointment Booking Call'])('%s: connected → spoke with and grade; not connected → reason', (t) => {
    expect(sees({ mx_Custom_1: t, Status: 'Yes' }, 'mx_Custom_24')).toBe(true);
    expect(sees({ mx_Custom_1: t, Status: 'Yes' }, 'mx_Custom_2')).toBe(true);
    expect(sees({ mx_Custom_1: t, Status: 'No' }, 'mx_Custom_24')).toBe(false);
    expect(sees({ mx_Custom_1: t, Status: 'No' }, 'mx_Custom_3')).toBe(true);
    expect(sees({ mx_Custom_1: t }, 'mx_Custom_20')).toBe(true); // Follow Up Date
  });

  test('Qualification: proceed Yes → student details; virtual demo Yes → appointment, No → reason; walk-in Yes → walk-in details', () => {
    const base = { mx_Custom_1: 'Qualification Call', Status: 'Yes', mx_Custom_46: 'Yes' };
    STUDENT.forEach(s => expect(sees(base, s)).toBe(true));
    STUDENT.forEach(s => expect(sees({ ...base, mx_Custom_46: 'No' }, s)).toBe(false));
    APPOINTMENT.forEach(s => expect(sees({ ...base, mx_Custom_58: 'Yes' }, s)).toBe(true));
    APPOINTMENT.forEach(s => expect(sees({ ...base, mx_Custom_58: 'No' }, s)).toBe(false));
    expect(sees({ ...base, mx_Custom_58: 'No' }, 'mx_Custom_36')).toBe(true);
    expect(sees({ ...base, mx_Custom_25: 'Yes' }, 'mx_Custom_26')).toBe(true);
    expect(sees({ ...base, mx_Custom_25: 'No' }, 'mx_Custom_27')).toBe(false);
  });

  test('Appointment Confirmation: type of booking and whether it is confirmed, no student details', () => {
    const base = { mx_Custom_1: 'Appointment Confirmation Call', mx_Custom_46: 'Yes' };
    expect(sees(base, 'mx_Custom_50')).toBe(true);
    expect(sees(base, 'mx_Custom_12')).toBe(true);
    expect(sees(base, 'mx_Custom_4')).toBe(false);
    expect(sees(base, 'mx_Custom_20')).toBe(false);
  });

  test('Demo Conducted and Conversion call show their own sections', () => {
    ['mx_Custom_30', 'mx_Custom_22', 'mx_Custom_44', 'mx_Custom_45', 'mx_Custom_32', 'mx_Custom_31']
      .forEach(s => expect(sees({ mx_Custom_1: 'Demo Conducted', mx_Custom_46: 'Yes' }, s)).toBe(true));
    expect(sees({ mx_Custom_1: 'Qualification Call', mx_Custom_46: 'Yes' }, 'mx_Custom_30')).toBe(false);
    ['mx_Custom_23', 'mx_Custom_15'].forEach(s => expect(sees({ mx_Custom_1: 'Conversion call', mx_Custom_46: 'Yes' }, s)).toBe(true));
    expect(sees({ mx_Custom_1: 'Conversion call' }, 'mx_Custom_20')).toBe(true);
  });

  test('always there: activity type, call connected, streams, notes, proceed', () => {
    ['mx_Custom_1', 'Status', 'mx_Custom_19', 'ActivityEvent_Note', 'mx_Custom_46']
      .forEach(s => expect(sees({ mx_Custom_1: 'Demo Conducted' }, s)).toBe(true));
  });
});
