/**
 * "This will use N credits" — said before anyone taps Generate.
 *
 * The number is the server's own rule applied to this request (core/billing/packs.js costOf),
 * so what is promised here is what is charged. Nothing is shown when the price is not known
 * or when credits are not being charged yet; when the balance falls short it says so and
 * offers the Credits screen, instead of letting the tap fail.
 *
 * A model that bills by the second of a video the person supplies (Motion Copy) cannot be
 * quoted until a video is chosen; until then the note says the rate. The server measures the
 * file itself, so the figure here, from the length the phone reports, is the same to the second.
 */

import { View, Text, Pressable, StyleSheet } from 'react-native'

import { costOf, costLine, formatCredits, priceRow, describePrice } from '@core/billing/packs'

import { useCredits } from '../hooks/useCredits'
import { openCredits } from '../navigation/ref'
import { useTheme, space, font } from '../theme'

/**
 * @param {{model: string, seconds?: number|string, mode?: string|null}} props
 */
export default function CostNote({ model, seconds, mode = null }) {
  const { colors } = useTheme()
  const credits = useCredits()
  if (!credits.enforced && !__DEV__) return null

  const cost = costOf(credits.prices, model, { seconds, mode })
  const line = costLine(cost)
  const row = priceRow(credits.prices, model, mode)
  const byTheSecond = line === null && row?.unit === 'per_second' && Number(row.credits) > 0
  if ((line === null && !byTheSecond) || credits.balance === null) return null

  const short = credits.enforced && cost > 0 && credits.balance < cost
  return (
    <View style={styles.wrap}>
      <Text style={[styles.text, font('regular'), { color: short ? colors.danger : colors.textSecondary }]}>
        {byTheSecond
          ? `Billed at ${describePrice(row)} of your video.`
          : cost === 0 ? 'This is free.' : `This will use ${line}.`} You have {formatCredits(credits.balance)}.
      </Text>
      {short ? (
        <Pressable onPress={openCredits} accessibilityRole="button" hitSlop={8}>
          <Text style={[styles.link, font('semibold'), { color: colors.primary }]}>Get credits</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  text: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  link: { fontSize: 14 },
})
