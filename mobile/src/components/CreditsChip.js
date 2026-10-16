/**
 * The credit balance, as the little pill at the top right of a tab (where the design puts
 * its "Pro" badge). Shown only when credits matter (useCredits: charging is on, or the account
 * holds some); tapping it opens the Credits screen. There is no subscription tier in this
 * app — what the badge can honestly say is the balance.
 */

import { Text, Pressable, StyleSheet } from 'react-native'

import { formatCredits } from '@core/billing/packs'

import { useCredits } from '../hooks/useCredits'
import { openCredits } from '../navigation/ref'
import { useTheme, font } from '../theme'
import Icon from './icons'

export default function CreditsChip() {
  const { colors } = useTheme()
  const credits = useCredits()
  if (!credits.visible || credits.balance === null) return null
  const low = credits.balance <= 0
  const fg = '#FFFFFF'
  return (
    <Pressable
      onPress={openCredits}
      accessibilityRole="button"
      accessibilityLabel={`${formatCredits(credits.balance)} credits. Open credits.`}
      style={[styles.chip, { backgroundColor: low ? colors.danger : colors.chip }]}
    >
      <Icon name="sparkle" size={13} color={fg} />
      <Text style={[styles.text, font('semibold'), { color: fg }]}>{formatCredits(credits.balance)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 26, borderRadius: 13 },
  text: { fontSize: 13 },
})
