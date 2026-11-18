import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import Dialer from '../modules/dialer';
import { useDialer } from '../lib/dialerStore';
import { ago, dueText } from '../components/LeadParts';
import { colors, Skeleton } from '../ui';
import { styles } from './dialerStyles';

// The leads to call: setup notices, the Pushed / Your leads switch, the Smart View chips, and the rows.
export default function ListScreen({ flow, granted, filesAccess, canFront, onRecordings }) {
  const { phase, queueInfo, views, view, slow, formState, tab } = useDialer(useShallow((s) => ({
    phase: s.phase, queueInfo: s.queueInfo, views: s.views, view: s.view, slow: s.slow, formState: s.formState, tab: s.tab,
  })));
  const { pickView, loadForm } = flow;
  const setTab = (t) => useDialer.setState({ tab: t }); // kept in the store, so a pause doesn't reset it

  const left = queueInfo?.count ?? 0;
  const pushedLeads = (queueInfo?.leads || []).filter((l) => l.pushed);
  const myLeads = (queueInfo?.leads || []).filter((l) => !l.pushed);
  // A Smart View chip picked: the list is that view, so the Pushed / Your leads switch goes away until "All".
  const inView = !!view && view !== 'own' && !!queueInfo && !queueInfo.rule;
  const shownTab = inView ? 'mine' : tab || (pushedLeads.length ? 'pushed' : 'mine');
  const tabLeads = shownTab === 'pushed' ? pushedLeads : myLeads;
  // Today's follow-ups still to come: their time shows on their row. One not in the list (called earlier today) is shown
  // under the overdue ones anyway, so it's never a surprise; it's dialed only once its time comes.
  const upcoming = (queueInfo?.upcoming || []).filter((u) => new Date(u.dueAt) > Date.now());
  const soon = new Map(upcoming.map((u) => [u.prospectId, u.dueAt]));
  const shownLeads = shownTab === 'mine'
    ? [...tabLeads.filter((l) => l.followUp), ...upcoming.filter((u) => !tabLeads.some((l) => l.prospectId === u.prospectId)),
      ...tabLeads.filter((l) => !l.followUp)]
    : tabLeads;
  const showViews = views?.length > 1 && !!queueInfo && !queueInfo.rule && (shownTab === 'mine' || !left || phase === 'done');

  // The open chip stays in sight, a little in from the left edge.
  const chipsRef = useRef(null);
  const chipX = useRef({});
  const scrollToChip = (id) => chipsRef.current?.scrollTo({ x: Math.max(0, (chipX.current[id] ?? 0) - 24), animated: true });

  return (
      <ScrollView contentContainerStyle={styles.list}>
        {!granted && <Text style={styles.notice}>Allow calls, phone state and call log to start dialing.</Text>}
        {formState === 'failed' && (
          <Text style={styles.notice}>
            Couldn't load your call form, so dialing is off.{' '}
            <Text style={styles.noticeLink} onPress={loadForm}>Try again</Text>
          </Text>
        )}
        {!filesAccess && (
          <Text style={styles.notice}>
            Turn on "All files access" so your call recordings reach Callyzer.{' '}
            <Text style={styles.noticeLink} onPress={onRecordings}>Set up</Text>
          </Text>
        )}
        {!canFront && (
          <Text style={styles.notice}>
            Turn on "Display over other apps" so the dialer returns after each call.{' '}
            <Text style={styles.noticeLink} onPress={() => Dialer.openBringToFrontSettings()}>Open settings</Text>
          </Text>
        )}

        {queueInfo && !!left && phase !== 'done' && !inView && (
          // Pushed leads are called first, then your leads: one switch shows either list.
          <View style={styles.segment} accessibilityRole="tablist">
            {[['pushed', 'Pushed with LSQ', pushedLeads.length], ['mine', 'Your leads', myLeads.length]].map(([key, label, n]) => (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected: shownTab === key }}
                style={[styles.segItem, shownTab === key && styles.segItemOn]}
                onPress={() => setTab(key)}
              >
                <Text style={[styles.segText, shownTab === key && styles.segTextOn]} numberOfLines={1}>{label}</Text>
                <Text style={[styles.segCount, shownTab === key && styles.segTextOn]}>{n}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {queueInfo?.rule && <Text style={[styles.muted, { marginTop: 12 }]}>From {queueInfo.rule.listName}, since {queueInfo.rule.startTime}</Text>}

        {/* Your leads, filtered by the Smart View tabs. Pushed leads are never filtered. */}
        {showViews && (
          <>
            <ScrollView ref={chipsRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.views} style={styles.viewsRow}>
              {views.map((v) => {
                const on = v.id === view;
                // The open view counts what's on screen; the others, the server's count (missing until it arrives).
                const n = on && queueInfo ? myLeads.length : v.count;
                const label = v.id === 'own' ? 'All' : v.name;
                return (
                  <Pressable
                    key={v.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={on && slow ? `${label}, loading` : n == null ? label : `${label}, ${n} ${n === 1 ? 'lead' : 'leads'}`}
                    onLayout={(e) => { chipX.current[v.id] = e.nativeEvent.layout.x; if (on) scrollToChip(v.id); }}
                    onPress={() => { if (!on) { pickView(v.id); scrollToChip(v.id); } }}
                    style={({ pressed }) => [styles.viewChip, on && styles.viewChipOn, pressed && !on && styles.pressed]}
                  >
                    <Text style={[styles.viewText, on && styles.viewTextOn]}>{label}</Text>
                    {on && slow ? (
                      <View style={[styles.viewCount, styles.viewCountOn]}>
                        <ActivityIndicator size="small" color={colors.text} style={{ transform: [{ scale: 0.7 }] }} />
                      </View>
                    ) : n != null && (
                      <View style={[styles.viewCount, on && styles.viewCountOn]}>
                        <Text style={[styles.viewCountText, on && styles.viewCountTextOn]}>{n}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        )}

        {queueInfo ? (
          (phase === 'done' || !left) ? (
            <View style={styles.caughtUp}>
              <Text style={styles.caughtUpTitle}>All caught up</Text>
              <Text style={styles.muted}>
                {view !== 'own' && !queueInfo.rule ? 'Nothing left in this view. Pick another above, or ' : 'No leads to call right now. '}
                ☰ → Refresh leads checks again.
              </Text>
            </View>
          ) : (
            <>
            
            {shownLeads.slice(0, 50).map((l) => {
              const calls = l.calls || 0;
              const about = calls ? `${calls} ${calls === 1 ? 'call' : 'calls'} · ${l.picked || 0} picked` : 'No calls yet';
              // A follow-up today takes the place of "Last call": overdue ones are already at the top of the list.
              const dueAt = l.followUp?.dueAt || soon.get(l.prospectId);
              const right = dueAt
                ? { label: l.followUp ? 'Overdue' : 'Follow-up', value: dueText(dueAt).replace(/^was due /, ''), late: !!l.followUp }
                : l.lastCall && { label: 'Last call', value: ago(l.lastCall) };
              return (
                <View key={l.prospectId} style={[styles.row, dueAt && styles.rowFollow]} accessible accessibilityLabel={`${l.name || 'No name'}, ${about}${right ? `, ${right.label} ${right.value}` : ''}`}>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{l.name || 'No name'}</Text>
                    <Text style={styles.rowAbout} numberOfLines={1}>{about}</Text>
                  </View>
                  {!!right && (dueAt ? (
                    // A follow-up: same layout as "Last call", marked by a small red dot.
                    <View style={styles.rowRight}>
                      <View style={styles.fuLabelRow}>
                        <View style={styles.fuDot} />
                        <Text style={styles.rowLabel}>{right.label}</Text>
                      </View>
                      <Text style={styles.rowAge}>{right.value}</Text>
                    </View>
                  ) : (
                    <View style={styles.rowRight}>
                      <Text style={styles.rowLabel}>{right.label}</Text>
                      <Text style={styles.rowAge}>{right.value}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
              {tabLeads.length > 50 && <Text style={styles.more}>and {tabLeads.length - 50} more</Text>}
              {!tabLeads.length && <Text style={styles.more}>None right now.</Text>}
            </>
          )
        ) : (
          <View accessibilityLabel="Loading your leads">
            {slow && (
              <View style={styles.slowNote}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={styles.muted}>Getting your leads from LeadSquared…</Text>
              </View>
            )}
            <Skeleton style={{ height: 44, borderRadius: 22 }} />
            <Skeleton style={{ width: 120, height: 14, marginTop: 28, marginBottom: 8 }} />
            {[0, 1, 2, 3, 4].map((i) => (
              <View key={i} style={styles.row}>
                <Skeleton style={{ flex: 1, height: 18, marginRight: 48 }} />
                <Skeleton style={{ width: 72, height: 14 }} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
  );
}
