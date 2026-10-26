/**
 * What a generation will cost, and what is left — said before anyone taps Generate.
 *
 * A small card with the credits icon, the price in large type, and the balance on the right. When
 * the balance falls short the card turns red, says how many credits are missing, and carries a
 * "Get credits" button — instead of a line of small red text that let the tap fail.
 *
 * The number is the server's own rule applied to this request (core/billing/packs.js costOf),
 * so what is promised here is what is charged. Nothing is shown when the price is not known
 * or when credits are not being charged yet.
 *
 * A model that bills by the second of a video the person supplies (Motion Copy) cannot be
 * quoted until a video is chosen; until then the card says the rate. The server measures the
 * file itself, so the figure here, from the length the phone reports, is the same to the second.
 */

import { View, Text, StyleSheet } from 'react-native'

import { costOf, costLine, formatCredits, priceRow, describePrice } from '@core/billing/packs'
import { creditShortfall, creditsWord } from '@core/billing/shortfall'

import { useCredits } from '../hooks/useCredits'
import { openCredits } from '../navigation/ref'
import { useTheme, space, font } from '../theme'
import Icon from './icons'
import { Button } from './ui'

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
  const missing = short ? creditShortfall({ balance: credits.balance, price: cost })?.short ?? 0 : 0

  const caption = byTheSecond ? 'Billed at' : cost === 0 ? 'Cost' : 'This will use'
  const amount = byTheSecond ? describePrice(row) : cost === 0 ? 'Free' : line
  const accent = short ? colors.danger : colors.primary

  return (
    <View
      style={[
        styles.card,
        short
          ? { backgroundColor: colors.dangerSoft, borderColor: `${colors.danger}55` }
          : { backgroundColor: colors.glass, borderColor: colors.glassEdge },
      ]}
      accessibilityLabel={`${caption} ${amount}${byTheSecond ? ' of your video' : ''}. Your balance is ${formatCredits(credits.balance)} credits.${short ? ` You need ${creditsWord(missing)} more.` : ''}`}
    >
      <View style={styles.row}>
        <View style={[styles.disc, { backgroundColor: short ? colors.dangerSoft : colors.accentSoft }]}>
          <Icon name="sparkle" size={20} color={accent} />
        </View>

        <View style={styles.main}>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>{caption}</Text>
          <Text style={[styles.amount, font('bold'), { color: colors.textPrimary }]} numberOfLines={1}>{amount}</Text>
          {byTheSecond ? <Text style={[styles.hint, { color: colors.textTertiary }]}>of your video</Text> : null}
        </View>

        <View style={styles.balance}>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>Your balance</Text>
          <Text style={[styles.balanceValue, font('bold'), { color: short ? colors.danger : colors.textPrimary }]}>
            {formatCredits(credits.balance)}
          </Text>
        </View>
      </View>

      {short ? (
        <View style={[styles.shortRow, { borderTopColor: `${colors.danger}33` }]}>
          <Text style={[styles.shortText, font('semibold'), { color: colors.danger }]}>
            You need {creditsWord(missing)} more
          </Text>
          <Button title="Get credits" size="sm" onPress={openCredits} style={styles.getCredits} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: 1, marginVertical: space.sm, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md },
  disc: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, gap: 1 },
  caption: { fontSize: 12 },
  amount: { fontSize: 19, letterSpacing: -0.3 },
  hint: { fontSize: 12 },
  balance: { alignItems: 'flex-end', gap: 1 },
  balanceValue: { fontSize: 17 },
  shortRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md,
    paddingHorizontal: space.md, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth,
  },
  shortText: { flex: 1, fontSize: 13.5 },
  getCredits: { minHeight: 36, paddingHorizontal: 18 },
})
