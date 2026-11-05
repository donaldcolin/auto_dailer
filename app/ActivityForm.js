import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { card, colors } from './ui';

// Options a dropdown offers right now: a dependent one follows its parent's value.
export const optionsFor = (f, values) => (f.dependent ? f.dependent[values[f.parent]] || [] : f.options);

// Set one value; drop children whose value no longer fits the new parent.
export function setValue(form, values, schema, value) {
  const next = { ...values, [schema]: value };
  for (const f of form.fields) {
    if (f.parent && next[f.schema] && !optionsFor(f, next).includes(next[f.schema])) delete next[f.schema];
  }
  return next;
}

const pad = (n) => String(n).padStart(2, '0');
const showDate = (iso) => {
  const d = new Date(iso);
  return `${d.toDateString().slice(4, 10)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The LSQ activity form, built from /api/activity-form. The team's sections first, the rest under "More fields". */
export default function ActivityForm({ form, values, onChange }) {
  const [more, setMore] = useState(false);
  const [picking, setPicking] = useState(null); // the dropdown field being chosen
  const set = (schema, v) => onChange(setValue(form, values, schema, v));
  // A dependent dropdown with nothing to offer (e.g. the failure reason on a connected call) is hidden.
  const visible = (f) => !f.dependent || optionsFor(f, values).length > 0;
  const sections = form.sections.map(([title, schemas]) => [title, schemas.map((s) => form.fields.find((f) => f.schema === s)).filter((f) => f && visible(f))]);
  const placed = form.sections.flatMap(([, schemas]) => schemas);
  const rest = form.fields.filter((f) => !placed.includes(f.schema) && visible(f));

  function pickDate(f) {
    const value = values[f.schema] ? new Date(values[f.schema]) : new Date();
    DateTimePickerAndroid.open({
      value, mode: 'date',
      onChange: (e, day) => {
        if (e.type !== 'set') return;
        DateTimePickerAndroid.open({
          value: day, mode: 'time',
          onChange: (e2, time) => { if (e2.type === 'set') set(f.schema, time.toISOString()); },
        });
      },
    });
  }

  function field(f, i, list) {
    const v = values[f.schema];
    const rowStyle = [styles.row, i === list.length - 1 && styles.lastRow];
    if (f.type === 'dropdown' || f.type === 'datetime') {
      return (
        <Pressable
          key={f.schema}
          accessibilityRole="button"
          accessibilityLabel={`${f.label}: ${v || 'not set'}`}
          style={({ pressed }) => [rowStyle, pressed && styles.pressed]}
          onPress={() => (f.type === 'dropdown' ? setPicking(f) : pickDate(f))}
        >
          <Text style={styles.label}>{f.label}{f.required ? ' *' : ''}</Text>
          <Text style={[styles.value, !v && styles.empty]}>{v ? (f.type === 'datetime' ? showDate(v) : v) : 'Choose'}</Text>
        </Pressable>
      );
    }
    return (
      <View key={f.schema} style={rowStyle}>
        <Text style={styles.label}>{f.label}{f.required ? ' *' : ''}</Text>
        <TextInput
          style={styles.input}
          value={v || ''}
          onChangeText={(t) => set(f.schema, t)}
          placeholder="Type here"
          placeholderTextColor={colors.muted}
          keyboardType={f.type === 'number' ? 'numeric' : 'default'}
          multiline={f.schema === 'ActivityEvent_Note'}
          accessibilityLabel={f.label}
        />
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        {sections.map(([title, list]) => (
          <View key={title || 'form'} style={styles.section}>
            {!!title && <Text style={styles.sectionTitle}>{title}</Text>}
            <View style={card}>{list.map(field)}</View>
          </View>
        ))}
        <Pressable accessibilityRole="button" onPress={() => setMore(!more)} style={styles.more}>
          <Text style={styles.moreText}>{more ? 'Fewer fields' : `More fields (${rest.length})`}</Text>
        </Pressable>
        {more && <View style={card}>{rest.map(field)}</View>}
      </ScrollView>

      <Modal visible={!!picking} transparent animationType="slide" onRequestClose={() => setPicking(null)}>
        <Pressable style={styles.scrim} onPress={() => setPicking(null)} accessibilityLabel="Close" />
        {picking && (
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{picking.label}</Text>
            <ScrollView>
              {['', ...optionsFor(picking, values)].map((o) => (
                <Pressable
                  key={o || '(none)'}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.option, pressed && styles.pressed]}
                  onPress={() => { set(picking.schema, o); setPicking(null); }}
                >
                  <Text style={[styles.optionText, !o && styles.empty, values[picking.schema] === o && o && styles.chosen]}>
                    {o || 'None'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  form: { paddingBottom: 24, gap: 20 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  row: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  lastRow: { borderBottomWidth: 0 },
  pressed: { backgroundColor: '#F5F5F5' },
  label: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  value: { fontSize: 17, color: colors.text },
  empty: { color: colors.muted },
  input: { fontSize: 17, color: colors.text, padding: 0 },
  more: { paddingBottom: 8 },
  moreText: { fontSize: 15, color: colors.text, textDecorationLine: 'underline' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { maxHeight: '60%', backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 24 },
  sheetTitle: { fontSize: 15, color: colors.muted, marginBottom: 8 },
  option: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  optionText: { fontSize: 17, color: colors.text },
  chosen: { fontWeight: '600' },
});
