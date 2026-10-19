/**
 * Choose a pack — the design's second payment screen, for packs of credits.
 *
 * The design: "Choose a Plan", the plan in a lavender pill, a list of what it includes with green
 * ticks, a Monthly / Yearly switch with the amount billed, and a black Continue. Here the plans are
 * packs (one payment, no subscription), so the switch becomes the packs themselves — tap one and the
 * pill, the list and the price follow — and the line under it says what is paid, once.
 *
 * What a pack is said to give comes from core/billing/offer.js packBenefits, from the server's own
 * prices: nothing is promised that the numbers do not back. Buying is usePackStore; this screen only
 * shows the packs and asks for the one that is chosen.
 */

import { useCallback, useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { formatCredits } from '@core/billing/packs'
import { packBenefits } from '@core/billing/offer'

import { usePackStore } from '../hooks/usePackStore'
import { useTheme, space, font } from '../theme'
import { Button } from '../components/ui'
import Icon from '../components/icons'
import { announcePurchase } from '../lib/purchaseAlert'

/** Below this height the pack chips move up under the pill, so choosing never needs a scroll. */
const SMALL_SCREEN = 720

/** One small icon per line of the list (the design draws one beside each). */
const BENEFIT_ICONS = {
  spend: 'sparkle',
  images: 'image',
  'never-expire': 'clock',
  refund: 'refresh',
  'one-payment': 'card',
}

export default function ChoosePackScreen({ navigation }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const { store, packs, credits, buying, waiting, busy, buy, reload } = usePackStore()

  const [chosenId, setChosenId] = useState(null)
  const pack = packs.find(p => p.id === chosenId) ?? packs[0] ?? null   // the pick, else the smallest

  const benefits = useMemo(() => (pack ? packBenefits(pack, credits.prices) : []), [pack, credits.prices])

  const onContinue = useCallback(async () => {
    if (!pack) return
    const { bought, arrived } = await buy(pack)
    if (bought) announcePurchase(pack, arrived, { onDone: () => navigation.popToTop() })
  }, [pack, buy, navigation])

  const compact = height < SMALL_SCREEN

  // Where the design has Monthly / Yearly: one chip per pack, and what is paid for the chosen one.
  const switcher = pack ? (
    <>
      <View style={[styles.switcher, { backgroundColor: colors.primary }]} accessibilityRole="radiogroup">
        {packs.map(p => {
          const active = p.id === pack.id
          return (
            <Pressable
              key={p.id}
              onPress={() => setChosenId(p.id)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityLabel={`${p.label}, ${p.price}`}
              accessibilityState={{ selected: active, disabled: busy }}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, font(active ? 'semibold' : 'regular')]}>{formatCredits(p.credits)}</Text>
            </Pressable>
          )
        })}
      </View>
      <Text style={[styles.billed, { color: colors.textPrimary }]}>Billed once: {pack.price}</Text>
    </>
  ) : null

  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + space.lg }]}>
        <Pressable onPress={() => navigation.goBack()} disabled={busy} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={[styles.back, { top: insets.top + space.lg }]}>
          <Icon name="back" size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={[styles.heading, font('regular'), { color: colors.textPrimary }]} accessibilityRole="header">Choose a pack</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {store.status === 'loading' ? (
          <View style={styles.state}><ActivityIndicator color={colors.primary} /></View>
        ) : store.status === 'failed' ? (
          <View style={styles.state}>
            <Text style={[styles.message, { color: colors.danger }]}>{store.message}</Text>
            <Pressable onPress={reload} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.link, font('semibold'), { color: colors.link }]}>Try again</Text>
            </Pressable>
          </View>
        ) : !pack ? (
          <View style={styles.state}>
            <Text style={[styles.message, { color: colors.textSecondary }]}>
              {store.status === 'unavailable' ? 'Buying credits is not set up in this version of the app.' : 'No credit packs are available right now.'}
            </Text>
          </View>
        ) : (
          <>
            {/* The lavender pill: the pack that is chosen. */}
            <LinearGradient
              colors={colors.isDark ? ['rgba(154,135,255,0.40)', 'rgba(154,135,255,0.14)'] : ['#BDB2FF', '#E9E5FF']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.lavender}
            >
              <Text style={[styles.packTitle, font('semibold'), { color: colors.primary }]} numberOfLines={1} adjustsFontSizeToFit>{pack.label}</Text>
              <Text style={[styles.packSub, { color: colors.textPrimary }]}>Pay once, use them any time</Text>
            </LinearGradient>

            {compact ? switcher : null}

            <View style={styles.list}>
              {benefits.map(b => (
                <View key={b.id} style={styles.item}>
                  <Icon name={BENEFIT_ICONS[b.id] || 'sparkle'} size={18} color={colors.textPrimary} />
                  <Text style={[styles.itemText, { color: colors.textPrimary }]}>{b.text}</Text>
                  <Icon name="check" size={20} color={colors.success} />
                </View>
              ))}
            </View>

            {compact ? null : switcher}
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.xl }]}>
        <Button title="Continue" variant="dark" onPress={onContinue} loading={!!pack && (buying === pack.id || waiting)} disabled={!pack || busy} />
        {waiting ? (
          <View style={styles.waiting}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.waitingText, { color: colors.textSecondary }]}>Adding your credits…</Text>
          </View>
        ) : (
          <Pressable onPress={() => navigation.popToTop()} disabled={busy} hitSlop={10} accessibilityRole="button" style={styles.notNow}>
            <Text style={[styles.notNowText, { color: colors.textSecondary }]}>Not now</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },

  header: { alignItems: 'center', paddingBottom: space.lg },
  back: { position: 'absolute', left: space.xl, paddingVertical: 2 },
  heading: { fontSize: 17 },

  content: { flexGrow: 1, paddingHorizontal: 40, paddingTop: space.xl, paddingBottom: space.xl, gap: space.xl + 6 },
  state: { alignItems: 'center', justifyContent: 'center', gap: space.md, minHeight: 240 },
  message: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  link: { fontSize: 14 },

  lavender: { borderRadius: 40, minHeight: 64, paddingVertical: space.md, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center', marginHorizontal: space.lg },
  packTitle: { fontSize: 29, letterSpacing: -0.4 },
  packSub: { fontSize: 11, marginTop: 1 },

  list: { gap: 17, marginTop: space.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  itemText: { flex: 1, fontSize: 15, lineHeight: 20 },

  switcher: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', borderRadius: 26, padding: 5, gap: 4, marginTop: space.md },
  chip: { minHeight: 36, minWidth: 74, borderRadius: 22, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  chipActive: { backgroundColor: 'rgba(255,255,255,0.24)', borderColor: 'rgba(255,255,255,0.55)' },
  chipText: { color: '#FFFFFF', fontSize: 14 },
  billed: { alignSelf: 'center', fontSize: 13, marginTop: -space.sm },

  footer: { paddingHorizontal: 58, paddingTop: space.md, gap: space.md },
  waiting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, minHeight: 36 },
  waitingText: { fontSize: 13 },
  notNow: { alignItems: 'center', justifyContent: 'center', minHeight: 36 },
  notNowText: { fontSize: 14 },
})
