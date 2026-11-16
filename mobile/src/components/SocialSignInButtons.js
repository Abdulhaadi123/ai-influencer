/**
 * The ways in that are not an email and a password: Apple (an iPhone) and Google (Android), one above the other,
 * under an "or" line when they sit beneath a form. Each button draws itself only where it can work, so on a
 * phone that offers neither this draws nothing at all, not even the line.
 */

import { View, Text, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'

import { useTheme, space, font } from '../theme'
import AppleSignInButton from './AppleSignInButton'
import GoogleSignInButton from './GoogleSignInButton'

/**
 * @param {{onError?: (message: string|null) => void, divider?: boolean}} props
 *        divider  draw an "or" line above the buttons (under an email form)
 */
export default function SocialSignInButtons({ onError, divider = false }) {
  const { colors } = useTheme()
  const { googleAvailable, appleAvailable } = useAuth()
  if (!googleAvailable && !appleAvailable) return null

  return (
    <View>
      {divider ? (
        <View style={styles.divider} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
          <Text style={[styles.or, font('regular'), { color: colors.textTertiary }]}>or</Text>
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
        </View>
      ) : null}
      <View style={styles.buttons}>
        <AppleSignInButton onError={onError} />
        <GoogleSignInButton onError={onError} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.lg },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  or: { fontSize: 13 },
  buttons: { gap: space.md },
})
