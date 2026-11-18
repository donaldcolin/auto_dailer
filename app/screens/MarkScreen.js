import { KeyboardAvoidingView, Pressable, ScrollView, Text, View } from 'react-native';
import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useShallow } from 'zustand/react/shallow';
import ActivityForm from '../ActivityForm';
import { useDialer } from '../lib/dialerStore';
import { LeadDetails, LeadHistory, pretty } from '../components/LeadParts';
import { colors } from '../ui';
import { styles } from './dialerStyles';

// After a call: the lead card on top, then one tap on a reason (not connected) or the team's form (connected).
export default function MarkScreen({ flow, status, histories }) {
  const { phase, lead, leadOpen, form, values, saving } = useDialer(useShallow((s) => ({
    phase: s.phase, lead: s.lead, leadOpen: s.leadOpen, form: s.form, values: s.values, saving: s.saving,
  })));
  const set = useDialer.setState;
  const setLeadOpen = (v) => set((s) => ({ leadOpen: typeof v === 'function' ? v(s.leadOpen) : v }));
  const setPhase = (p) => set({ phase: p });
  const setValues = (v) => set({ values: v });
  const { openOnLaptop, submit } = flow;
  const [savingReason, setSavingReason] = useState(null); // the reason row just tapped, shown as "Saving…"
  const reasons = form?.connected ? form.fields.find((f) => f.schema === form.connected.reason).dependent.No : [];

  return (
      // Android 15 draws apps edge to edge and no longer shrinks them for the keyboard: this does, so the form and Save stay reachable.
      <KeyboardAvoidingView behavior="padding" style={styles.mark}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: leadOpen }}
          accessibilityHint="Shows the lead's details"
          style={styles.leadCard}
          onPress={() => setLeadOpen((o) => !o)}
        >
          <View style={styles.leadHead}>
            <View style={styles.teamBody}>
              <Text style={styles.cardName} numberOfLines={1}>{lead.name || 'No name'}</Text>
              <Text style={styles.cardMeta} numberOfLines={1}>{status}, {pretty(lead.phone)}</Text>
            </View>
            <Ionicons name={leadOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.muted} />
          </View>
          {leadOpen && (
            <>
              {!!lead.stage && <Text style={[styles.cardMeta, { marginTop: 8 }]}>{lead.stage}{lead.pushed ? ', pushed by your TL' : ''}</Text>}
              <LeadDetails details={lead.details} compact />
              <LeadHistory history={histories[lead.prospectId] || {}} compact />
            </>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.laptop, pressed && styles.outcomePressed]}
          onPress={openOnLaptop}
        >
          <Ionicons name="laptop-outline" size={18} color={colors.text} />
          <Text style={styles.laptopText}>Open on laptop</Text>
        </Pressable>

        <Text style={[styles.sectionTitle, phase === 'outcome' && { marginBottom: 12 }]}>
          {phase === 'reason' ? "Why didn't it connect?" : form.name}
        </Text>
        {phase === 'reason' && <Text style={styles.sectionHint}>Tap a reason to save the {form.name}.</Text>}

        {phase === 'reason' && (
          <ScrollView style={styles.outcomes} contentContainerStyle={styles.outcomeList}>
            {reasons.map((r, i) => (
              <Pressable
                key={r}
                accessibilityRole="button"
                disabled={saving}
                style={({ pressed }) => [styles.outcome, pressed && styles.outcomePressed]}
                onPress={async () => {
                  setSavingReason(r);
                  await submit({ ...values, [form.connected.reason]: r });
                  setSavingReason(null);
                }}
              >
                <Text style={styles.outcomeText}>{r}</Text>
                {savingReason === r && <Text style={styles.muted}>Saving…</Text>}
              </Pressable>
            ))}
          </ScrollView>
        )}
        {phase === 'reason' && (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.outcome, styles.fullForm, pressed && styles.outcomePressed]}
            onPress={() => setPhase('outcome')}
          >
            <Text style={styles.outcomeText}>Fill the full form instead</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Pressable>
        )}

        {phase === 'outcome' && (
          <View style={styles.formBox}>
            <ActivityForm form={form} values={values} onChange={setValues} />
          </View>
        )}
      </KeyboardAvoidingView>
  );
}
