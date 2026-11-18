import { Animated, ScrollView, Text, View } from 'react-native';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDialer } from '../lib/dialerStore';
import { dueText, LatestNote, LeadDetails, LeadHistory, locationOf, pretty } from '../components/LeadParts';
import { Skeleton } from '../ui';
import { styles } from './dialerStyles';

// The next lead loading, its countdown, and the call: the lead's name, number, details, latest note and recent activity.
// A finger on the screen holds the countdown.
export default function CallScreen({ status, histories, countdownBar }) {
  const { phase, lead, held } = useDialer(useShallow((s) => ({ phase: s.phase, lead: s.lead, held: s.held })));
  const setHeld = (h) => useDialer.setState({ held: h });
  // A scroll takes over the touch and sends touchCancel with the finger still down, so a drag releases on its own end.
  const draggingRef = useRef(false);
  const dragStart = () => { draggingRef.current = true; setHeld(true); };
  const dragEnd = () => { draggingRef.current = false; setHeld(false); };
  const touchCancel = () => { if (!draggingRef.current) setHeld(false); };

  if (phase === 'loading') {
    return (
        <View style={styles.call} accessibilityLabel="Loading the next lead">
          <Skeleton style={{ width: 90, height: 16, marginBottom: 16 }} />
          <Skeleton style={{ width: '70%', height: 34, marginBottom: 12 }} />
          <Skeleton style={{ width: 150, height: 18, marginBottom: 8 }} />
          <Skeleton style={{ width: 110, height: 18 }} />
        </View>
    );
  }
  return (
      <View style={styles.formBox} onTouchStart={() => setHeld(true)} onTouchEnd={() => setHeld(false)} onTouchCancel={touchCancel}>
        {/* Stays pinned while the lead scrolls: when the call happens is what matters most here. */}
        {phase === 'countdown' && (
          <View style={styles.barTrack}>
            <Animated.View style={[styles.barFill, { transform: [{ scaleX: countdownBar }] }]} />
          </View>
        )}
        <View style={styles.banner} accessibilityLiveRegion="polite">
          {phase === 'calling' && <View style={styles.liveDot} />}
          <Text style={styles.bannerText}>{status}</Text>
          {phase === 'countdown' && <Text style={styles.bannerHint}>{held ? 'Lift to continue' : 'Hold the screen to pause'}</Text>}
        </View>
        <ScrollView
          key={lead.prospectId} // a fresh screen per lead: starts at the top, no scroll carried over
          contentContainerStyle={styles.call}
          onScrollBeginDrag={dragStart}
          onScrollEndDrag={dragEnd}
        >
          {!!lead.followUp && (
            // Same grey as follow-up rows in the list, so it reads as the same thing.
            <View style={styles.followUp} accessibilityRole="alert">
              <View style={styles.fuDot} />
              <Text style={styles.followUpText}>
                {dueText(lead.followUp.dueAt) === 'due today' ? 'Follow-up due today' : `Follow-up due at ${dueText(lead.followUp.dueAt).replace(/^was due /, '')}`}
              </Text>
            </View>
          )}
          <Text style={styles.callName}>{lead.name || 'No name'}</Text>
          <Text style={styles.callPhone}>{pretty(lead.phone)}</Text>
          <View style={styles.tags}>
            {!!lead.stage && <Text style={styles.tag}>{lead.stage}</Text>}
            {!!locationOf(lead) && <Text style={styles.tag}>{locationOf(lead)}</Text>}
            {lead.pushed && <Text style={[styles.tag, styles.tagOn]}>Pushed by your TL</Text>}
          </View>
          <LeadDetails details={lead.details} omit={['Location']} />
          <LatestNote history={histories[lead.prospectId]} />
          <LeadHistory history={histories[lead.prospectId] || {}} hideNotes />
        </ScrollView>
      </View>
  );
}
