const mockPost = jest.fn();
jest.mock('../config/lsq', () => ({ lsqClient: { post: (...a) => mockPost(...a), get: jest.fn() }, lsqUrl: p => p, lsqParams: () => ({ host: 'https://lsq' }) }));
jest.mock('../config/supabase', () => ({}));
const { FORMS, activityEventFor, toForm, toLsqFields, postActivity } = require('../services/activity');

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
const form = toForm(TYPE);

test('the mode picks the activity: HR 284, Sales 218, nothing before setup', () => {
  expect(activityEventFor({ mode: 'hr' })).toBe(284);
  expect(activityEventFor({ mode: 'sales' })).toBe(218);
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
  expect(new Set([...first[1], ...second[1]]).size).toBe(first[1].length + second[1].length);
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
