import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { card, colors } from './ui';

// Options a dropdown offers right now: a dependent one follows its parent's value.
export const optionsFor = (f, values) => (f.dependent ? f.dependent[values[f.parent]] || [] : f.options);

// Same logic as `shown` in backend/services/activity.js: a field some rule names shows only while one of those rules matches.
const shown = (rules, schema, values) => {
  const own = (rules || []).filter((r) => r.show.includes(schema));
  return !own.length || own.some((r) => Object.entries(r.when).every(([k, v]) => (v === true ? !!values[k] : values[k] === v)));
};

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
  const [picking, setPicking] = useState(null); // the schema of the dropdown that's open
  const scroll = useRef(null);
  const view = useRef({ height: 0, y: 0 });
  const rows = useRef({});
  const set = (schema, v) => onChange(setValue(form, values, schema, v));
  // A dependent dropdown with nothing to offer (e.g. the failure reason on a connected call) is hidden.
  // A field the form's rules hide (another round's fields) is hidden too, as in LSQ's own form.
  const visible = (f) => (!f.dependent || optionsFor(f, values).length > 0) && shown(form.rules, f.schema, values);
  const sections = form.sections
    .map(([title, schemas]) => [title, schemas.map((s) => form.fields.find((f) => f.schema === s)).filter((f) => f && visible(f))])
    .filter(([, list]) => list.length);
  const placed = form.sections.flatMap(([, schemas]) => schemas);
  const rest = form.fields.filter((f) => !placed.includes(f.schema) && visible(f));

  const toggle = (setOpen) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen();
  };

  // An option list opened near the bottom would stay below the screen, so bring it into view.
  useEffect(() => {
    if (!picking) return;
    rows.current[picking]?.measureLayout(scroll.current.getInnerViewRef(), (x, y, w, h) => {
      const bottom = y + h + 8 - view.current.height;
      if (bottom > view.current.y) scroll.current.scrollTo({ y: Math.min(y, bottom) });
    });
  }, [picking]);

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

  function field(f) {
    const v = values[f.schema];
    if (f.type === 'dropdown' || f.type === 'datetime') {
      const open = picking === f.schema;
      const isDate = f.type === 'datetime';
      return (
        <View key={f.schema} ref={(r) => { rows.current[f.schema] = r; }} collapsable={false} style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${f.label}: ${v || 'not set'}`}
            accessibilityState={isDate ? undefined : { expanded: open }}
            style={styles.rowHead}
            onPress={() => (isDate ? pickDate(f) : toggle(() => setPicking(open ? null : f.schema)))}
          >
            <Text style={styles.label}>{f.label}</Text>
            <Text style={[styles.value, !v && styles.empty]} numberOfLines={1}>
              {v ? (isDate ? showDate(v) : v) : f.required ? 'Required' : 'Choose'}
            </Text>
            <Ionicons name={isDate ? 'calendar-outline' : open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.muted} />
          </Pressable>
          {open && (
            <View style={styles.options}>
              {optionsFor(f, values).map((o) => (
                <Pressable
                  key={o}
                  accessibilityRole="button"
                  accessibilityState={{ selected: v === o }}
                  style={[styles.option, v === o && styles.optionOn]}
                  onPress={() => {
                    set(f.schema, v === o ? '' : o); // tapping the chosen option clears it
                    toggle(() => setPicking(null));
                  }}
                >
                  <Text style={[styles.optionText, v === o && styles.optionTextOn]}>{o}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      );
    }
    return (
      <View key={f.schema} style={[styles.row, styles.textRow]}>
        <Text style={styles.textLabel}>{f.label}</Text>
        <TextInput
          style={styles.input}
          value={v || ''}
          onChangeText={(t) => set(f.schema, t)}
          placeholder={f.required ? 'Required' : 'Type here'}
          placeholderTextColor={colors.muted}
          keyboardType={f.type === 'number' ? 'numeric' : 'default'}
          multiline={f.schema === 'ActivityEvent_Note'}
          accessibilityLabel={f.label}
        />
      </View>
    );
  }

  return (
    <ScrollView
      ref={scroll}
      contentContainerStyle={styles.form}
      keyboardShouldPersistTaps="handled"
      onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; }}
      onScroll={(e) => { view.current.y = e.nativeEvent.contentOffset.y; }}
      scrollEventThrottle={100}
    >
      {sections.map(([title, list]) => (
        <View key={title || 'form'} style={styles.section}>
          {!!title && <Text style={styles.sectionTitle}>{title}</Text>}
          {list.map(field)}
        </View>
      ))}
      {form.more !== false && rest.length > 0 && <View style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: more }}
          style={[styles.row, styles.rowHead]}
          onPress={() => toggle(() => setMore(!more))}
        >
          <Text style={styles.label}>More fields</Text>
          <Text style={[styles.value, styles.empty]}>{rest.length}</Text>
          <Ionicons name={more ? 'chevron-up' : 'chevron-down'} size={20} color={colors.muted} />
        </Pressable>
        {more && rest.map(field)}
      </View>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  form: { paddingBottom: 24, gap: 20 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
  row: { ...card, backgroundColor: '#F7F7F7' }, // same as the lead card above
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 },
  label: { flex: 1, fontSize: 15, color: colors.text },
  value: { flexShrink: 1, maxWidth: '50%', fontSize: 15, fontWeight: '600', color: colors.text, textAlign: 'right' },
  empty: { fontWeight: '400', color: colors.muted },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 16 },
  option: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22, backgroundColor: colors.bg },
  optionOn: { backgroundColor: colors.text },
  optionText: { fontSize: 15, color: colors.text },
  optionTextOn: { color: colors.bg, fontWeight: '600' },
  textRow: { paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  textLabel: { fontSize: 15, color: colors.text },
  input: { fontSize: 15, color: colors.text, padding: 0, minHeight: 24 },
});
