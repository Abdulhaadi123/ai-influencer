/**
 * "This will use N credits" — said before anyone taps Generate.
 *
 * The number is the server's own rule applied to this request (core/billing/packs.js costOf),
 * so what is promised here is what is charged. Nothing is shown when the price is not known
 * or when credits are not being charged yet; when the balance falls short it says so and
 * offers the Credits screen, instead of letting the tap fail.
 */

import { View, Text, Pressable, StyleSheet } from 'react-native'

import { costOf, costLine, formatCredits } from '@core/billing/packs'

import { useCredits } from '../hooks/useCredits'
import { openCredits } from '../navigation/ref'
import { useTheme, space } from '../theme'

/**
 * @param {{model: string, seconds?: number|string}} props
 */
export default function CostNote({ model, seconds }) {
  const { colors } = useTheme()
  const credits = useCredits()
  if (!credits.enforced && !__DEV__) return null

  const cost = costOf(credits.prices, model, { seconds })
  const line = costLine(cost)
  if (line === null || credits.balance === null) return null

  const short = credits.enforced && cost > 0 && credits.balance < cost
  return (
    <View style={styles.wrap}>
      <Text style={[styles.text, { color: short ? colors.danger : colors.textSecondary }]}>
        {cost === 0 ? 'This is free.' : `This will use ${line}.`} You have {formatCredits(credits.balance)}.
      </Text>
      {short ? (
        <Pressable onPress={openCredits} accessibilityRole="button" hitSlop={8}>
          <Text style={[styles.link, { color: colors.brandDeep }]}>Get credits</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  text: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  link: { fontSize: 14, fontWeight: '700' },
})
