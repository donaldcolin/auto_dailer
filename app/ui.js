import { Pressable, StyleSheet, Text } from 'react-native';

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

// primary: black fill for the one main action. plain: text only, for everything else.
export function Btn({ title, onPress, kind = 'primary', disabled, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btn, kind === 'primary' && styles.primary, (disabled || pressed) && styles.dim, style]}
    >
      <Text style={[styles.text, kind === 'primary' && styles.primaryText]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 56, borderRadius: 28, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.text },
  text: { fontSize: 17, fontWeight: '500', color: colors.text },
  primaryText: { color: colors.bg },
  dim: { opacity: 0.4 },
});
