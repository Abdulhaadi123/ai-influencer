/**
 * "By … you agree to the Terms of Use and Privacy Policy" — two links in one sentence.
 *
 * On the welcome and sign-up screens, so the privacy policy is reachable from inside the app
 * before an account exists (Google Play's User Data policy asks for it in the app itself), and so
 * creating an account is an agreement to the terms the person can read first. Settings has the
 * same pages as rows (screens/SettingsScreen.js).
 */

import { Text, StyleSheet } from 'react-native'

import { useTheme, font } from '../theme'
import { openLegal } from '../lib/openLegal'

const NBSP = ' '

/** @param {{lead?: string, style?: any}} props  lead: the start of the sentence */
export default function LegalNote({ lead = 'By creating an account you agree to the', style }) {
  const { colors } = useTheme()
  const link = [styles.link, font('medium'), { color: colors.link }]
  return (
    <Text style={[styles.note, { color: colors.textSecondary }, style]}>
      {lead}{' '}
      {/* No-break spaces, so a link name never splits over two lines ("Privacy" / "Policy"). */}
      <Text style={link} onPress={() => openLegal('terms')} accessibilityRole="link">Terms{NBSP}of{NBSP}Use</Text>
      {' '}and{' '}
      <Text style={link} onPress={() => openLegal('privacy')} accessibilityRole="link">Privacy{NBSP}Policy</Text>.
    </Text>
  )
}

const styles = StyleSheet.create({
  note: { fontSize: 13, lineHeight: 20, textAlign: 'center' },
  link: { fontSize: 13, textDecorationLine: 'underline' },
})
