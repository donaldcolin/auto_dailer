import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';

// White, black and grey. Red belongs to the logo and the live-call dot only.
export const colors = {
  bg: '#FFFFFF',
  text: '#000000',
  muted: '#8A8F98',
  line: '#EBEBEB',
  red: '#FF0000',
};

export const logo = require('./assets/logo.png');
export const wordmark = require('./assets/wordmark.png'); // the full red Kalvium logo

// primary: black fill for the one main action. plain: outlined, for everything else.
export function Btn({ title, onPress, kind = 'primary', disabled, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btn, kind === 'primary' ? styles.primary : styles.plain, (disabled || pressed) && styles.dim, style]}
    >
      <Text style={[styles.text, kind === 'primary' && styles.primaryText]}>{title}</Text>
    </Pressable>
  );
}

// Confirmation that slides up and fades in, then fades out when `text` goes back to null.
export function Toast({ text }) {
  const [shown, setShown] = useState(text);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (text) setShown(text);
    Animated.timing(anim, { toValue: text ? 1 : 0, duration: 200, useNativeDriver: true })
      .start(({ finished }) => { if (finished && !text) setShown(null); });
  }, [text]);
  if (!shown) return null;
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  return (
    <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.toast, { opacity: anim, transform: [{ translateY }] }]}>
      <Ionicons name="checkmark-circle" size={20} color={colors.bg} />
      <Text style={styles.toastText} numberOfLines={2}>{shown}</Text>
    </Animated.View>
  );
}

// Bordered group for rows: the lead, the form's fields, the reasons.
export const card = { borderWidth: StyleSheet.hairlineWidth, borderColor: '#DADADA', borderRadius: 16, backgroundColor: colors.bg, overflow: 'hidden' };

const styles = StyleSheet.create({
  toast: { position: 'absolute', left: 24, right: 24, bottom: 112, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.text, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, elevation: 4 },
  toastText: { flex: 1, color: colors.bg, fontSize: 15, fontWeight: '500' },
  btn: { minHeight: 56, borderRadius: 28, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.text },
  plain: { borderWidth: 1.5, borderColor: colors.line },
  text: { fontSize: 17, fontWeight: '500', color: colors.text },
  primaryText: { color: colors.bg },
  dim: { opacity: 0.4 },
});

// Grey placeholder that gently pulses while content loads. Size it with `style`.
export function Skeleton({ style }) {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
    ]));
    pulse.start();
    return () => pulse.stop();
  }, []);
  return <Animated.View style={[{ backgroundColor: colors.line, borderRadius: 8, opacity }, style]} />;
}

