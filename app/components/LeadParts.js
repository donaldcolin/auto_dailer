import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, Skeleton } from '../ui';
import { styles } from '../screens/dialerStyles';

export const dialable = (phone) => String(phone).replace(/[^\d+]/g, ''); // LSQ stores "+91-98…"
// "+91-8431772316" → "+91 84317 72316"
export const pretty = (phone) => dialable(phone).replace(/^(\+91)?(\d{5})(\d{5})$/, (_, cc, a, b) => `${cc ? cc + ' ' : ''}${a} ${b}`);

// Source, location, past calls… from LSQ, as label/value rows (only the filled ones arrive).
// The lead's place ("Karnataka", or "Bengaluru, Karnataka"), shown as a tag next to its stage.
export const locationOf = (lead) => lead.details?.find((d) => d.label === 'Location')?.value || '';

// Lead age and last spoke left out (Donald, 2026-11-15): the calls line and Recent activity say what matters.
const HIDDEN_DETAILS = ['Lead age', 'Last spoke'];
export function LeadDetails({ details, compact, omit = [] }) {
  const shown = (details || []).filter((d) => !HIDDEN_DETAILS.includes(d.label) && !omit.includes(d.label));
  if (!shown.length) return null;
  return (
    <View style={compact ? styles.detailsCompact : styles.details}>
      {shown.map((d) => (
        <View key={d.label} style={styles.detailRow}>
          <Text style={[styles.detailLabel, compact && styles.detailSmall]}>{d.label}</Text>
          <Text style={[styles.detailValue, compact && styles.detailSmall]} numberOfLines={2}>{d.value}</Text>
        </View>
      ))}
    </View>
  );
}

// The lead's latest LSQ activities: earlier HR Activities with what was marked, calls, pushes…
// The lead's newest note (from an activity or the Notes tab), on its own before Recent activity: read before you talk.
export function LatestNote({ history }) {
  const h = history?.items?.find((i) => i.note);
  if (!h) return null;
  const who = h.kind === 'note' ? h.detail.replace(/^by /, '') : h.what;
  return (
    <View style={styles.latestNote} accessible accessibilityLabel={`Latest note: ${h.note}. ${who}, ${h.at}`}>
      <Text style={styles.historyTitle}>Latest note</Text>
      <Text style={styles.latestNoteText}>{h.note}</Text>
      <Text style={styles.historySub}>{who}, {h.at}</Text>
    </View>
  );
}

export function LeadHistory({ history, compact, hideNotes }) {
  if (!history) return null;
  // With the note shown above, the history keeps to what happened: the Notes-tab line itself goes too.
  const all = (history.items || []).filter((i) => !(hideNotes && i.kind === 'note'));
  const items = compact ? all.slice(0, 2) : all;
  return (
    <View style={compact ? styles.detailsCompact : styles.history}>
      {!compact && <Text style={styles.historyTitle}>Recent activity</Text>}
      {history.failed && <Text style={styles.historySub}>Couldn't load past activity.</Text>}
      {!history.failed && !history.items && <Skeleton style={{ height: 14, width: '70%', marginVertical: 6 }} />}
      {history.items && !history.items.length && <Text style={styles.historySub}>No earlier activity.</Text>}
      {items.map((h, i) => {
        // One line per call: spoke (with how long), didn't connect (why), or something else that happened.
        // A call has a phone (filled if it connected), a marked activity a pen, a note a page, a stage change arrows.
        const isCall = h.what === 'Outgoing call' || h.what === 'Incoming call';
        const icon = h.kind === 'note' ? 'document-text-outline'
          : h.what === 'Stage changed' ? 'swap-horizontal-outline'
            : isCall ? (h.kind === 'spoke' ? 'call' : 'call-outline')
              : 'create-outline';
        const tint = h.kind === 'missed' ? colors.muted : colors.text;
        return (
          <View key={i} style={[styles.historyRow, compact && { paddingVertical: 2 }, i === items.length - 1 && { borderBottomWidth: 0 }]}>
            <View style={styles.historyHead}>
              {!compact && <Ionicons name={icon} size={16} color={tint} style={styles.historyIcon} />}
              <Text style={[styles.historyWhat, compact && styles.detailSmall]} numberOfLines={1}>{h.what}</Text>
              <Text style={[styles.historyAt, compact && styles.detailSmall]}>{h.at}</Text>
            </View>
            {/* A Notes-tab note: its text is the point, so the compact view shows it instead of who wrote it. */}
            {!!(compact && h.kind === 'note' ? h.note : h.detail) && <Text style={[styles.historySub, !compact && styles.historyIndent, compact && styles.detailSmall]} numberOfLines={compact ? 1 : 2}>{compact && h.kind === 'note' ? h.note : h.detail}</Text>}
            {!!h.note && !compact && !hideNotes && <Text style={[styles.historyNote, styles.historyIndent]} numberOfLines={3}>{h.note}</Text>}
          </View>
        );
      })}
    </View>
  );
}

// A due follow-up's time: "was due 4:30 pm", or "due today" for a date-only follow-up (LSQ stores those at midnight).
export function dueText(iso) {
  const t = new Date(iso);
  return t.getHours() === 0 && t.getMinutes() === 0 ? 'due today' : `was due ${t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

// When a lead was last dialed, short: "Just now", "25 min ago", "Today, 7:12 pm", "Yesterday", "3 days ago", "4 Nov".
export function ago(iso, now = Date.now()) {
  const t = new Date(iso);
  const min = Math.round((now - t) / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const day = (d) => new Date(d).toDateString();
  if (day(t) === day(now)) return `Today, ${t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
  if (day(t) === day(now - 86400000)) return 'Yesterday';
  const days = Math.floor((now - t) / 86400000);
  if (days < 7) return `${days} days ago`;
  return t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
