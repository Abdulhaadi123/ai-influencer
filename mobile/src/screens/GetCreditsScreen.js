/**
 * Get credits — the design's first payment screen, for packs of credits.
 *
 * The design sells a plan here: the picture, a Monthly / Yearly switch, one plan in a violet pill,
 * Continue, and "See all plans". This app has no subscription — a pack is one payment, and its
 * credits never expire — so the switch is gone (there is nothing to repeat) and the pill offers the
 * smallest pack: what it gives, what it costs. Continue buys it; "See all packs" opens the other
 * screen (ChoosePackScreen), where the packs are compared.
 *
 * It is an OFFER, not a gate. src/hooks/useOfferPacks.js opens it once, to someone who has no credits;
 * Skip — and the phone's Back — leave it, and Credits stays reachable from the header chip and Settings.
 * Nothing here grants credits: see usePackStore.
 */

import { useCallback } from 'react'
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePackStore } from '../hooks/usePackStore'
import { useTheme, space, font } from '../theme'
import { Button } from '../components/ui'
import Icon from '../components/icons'
import { LogoMark, Orb } from '../components/brand'
import { welcomeHero } from '../assets/heroes'
import { announcePurchase } from '../lib/purchaseAlert'

/** The white sheet's rounded top rides this far over the picture, so the corners show it, not the page. */
const SHEET_OVERLAP = 48
/** Below this height the mark is left out: the headline and the sheet need the room. */
const SMALL_SCREEN = 720

export default function GetCreditsScreen({ navigation }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const compact = useWindowDimensions().height < SMALL_SCREEN
  const { store, packs, buying, waiting, busy, buy, reload } = usePackStore()

  const pack = packs[0] ?? null   // the smallest: joinPacks sorts smallest first

  const onContinue = useCallback(async () => {
    if (!pack) return
    const { bought, arrived } = await buy(pack)
    if (bought) announcePurchase(pack, arrived, { onDone: () => navigation.popToTop() })
  }, [pack, buy, navigation])

  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <View style={styles.hero}>
        {welcomeHero ? (
          <Image source={welcomeHero} style={styles.picture} resizeMode="cover" />
        ) : (
          // The picture's colours — a magenta wash on the left, blue on the right — until it is added.
          <LinearGradient
            colors={['#D653C6', '#8A5CF0', '#4D6BEF']}
            start={{ x: 0, y: 0.1 }} end={{ x: 1, y: 0.9 }}
            style={styles.picture}
          />
        )}

        {/* The headline sits in the middle of what the sheet leaves free. */}
        <View
          style={[styles.heading, { paddingTop: insets.top + space.xxl, paddingBottom: SHEET_OVERLAP + space.lg }]}
          pointerEvents="none"
        >
          {compact ? null : <LogoMark height={52} color="#FFFFFF" />}
          <Text style={[styles.title, font('bold'), compact && styles.titleSmall]} accessibilityRole="header">{'Get credits\nto create'}</Text>
          <Text style={styles.subtitle}>One payment. No subscription.</Text>
        </View>

        <Pressable
          onPress={() => navigation.goBack()}
          disabled={busy}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Skip"
          style={[styles.skip, { top: insets.top + space.md }]}
        >
          <Text style={[styles.skipText, font('medium'), busy && { opacity: 0.4 }]}>Skip</Text>
        </Pressable>
      </View>

      <View style={[styles.sheet, { backgroundColor: colors.bg, paddingBottom: insets.bottom + space.xl }]}>
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
            <View
              style={[styles.pill, { backgroundColor: colors.primary }]}
              accessible
              accessibilityLabel={`${pack.label}, ${pack.price}, one payment`}
            >
              <View style={styles.pillSide}>
                <Text style={[styles.pillTitle, font('semibold')]} numberOfLines={1}>{pack.label}</Text>
                <View style={styles.pillSubRow}>
                  <Orb size={9} />
                  <Text style={styles.pillSub} numberOfLines={1}>Credits never expire</Text>
                </View>
              </View>
              <View style={[styles.pillSide, styles.pillRight]}>
                <Text style={[styles.pillTitle, font('semibold')]} numberOfLines={1}>{pack.price}</Text>
                <Text style={styles.pillSub} numberOfLines={1}>One payment</Text>
              </View>
            </View>

            <Button title="Continue" variant="dark" onPress={onContinue} loading={buying === pack.id || waiting} disabled={busy} />

            {waiting ? (
              <View style={styles.waiting}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.waitingText, { color: colors.textSecondary }]}>Adding your credits…</Text>
              </View>
            ) : (
              <Pressable
                onPress={() => navigation.navigate('ChoosePack')}
                disabled={busy}
                hitSlop={10}
                accessibilityRole="button"
                style={styles.seeAll}
              >
                <Text style={[styles.seeAllText, font('regular'), { color: colors.textPrimary }]}>See all packs</Text>
                <Icon name="chevron" size={14} color={colors.textPrimary} />
              </Pressable>
            )}
          </>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  hero: { flex: 1 },
  picture: { ...StyleSheet.absoluteFill, width: '100%', height: undefined },

  heading: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  title: {
    color: '#FFFFFF', fontSize: 48, lineHeight: 54, letterSpacing: -1, textAlign: 'center', marginTop: space.xl,
    textShadowColor: 'rgba(20,10,80,0.28)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 14,
  },
  titleSmall: { fontSize: 38, lineHeight: 44, marginTop: 0 },
  subtitle: { color: 'rgba(255,255,255,0.92)', fontSize: 16, marginTop: space.md },

  skip: { position: 'absolute', right: space.xl, paddingVertical: space.sm, paddingHorizontal: space.sm },
  skipText: { color: '#FFFFFF', fontSize: 16 },

  sheet: {
    marginTop: -SHEET_OVERLAP,
    borderTopLeftRadius: 48, borderTopRightRadius: 48,
    paddingTop: space.xxl, paddingHorizontal: 36, gap: space.lg,
  },
  state: { alignItems: 'center', justifyContent: 'center', gap: space.md, minHeight: 190 },
  message: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  link: { fontSize: 14 },

  // The violet plan pill of the design: the pack on the left, its price on the right.
  pill: { minHeight: 60, borderRadius: 30, paddingHorizontal: 28, paddingVertical: space.sm + 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  pillSide: { flexShrink: 1, gap: 3 },
  pillRight: { alignItems: 'flex-end' },
  pillTitle: { color: '#FFFFFF', fontSize: 17 },
  pillSubRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pillSub: { color: 'rgba(255,255,255,0.82)', fontSize: 11 },

  waiting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, minHeight: 36 },
  waitingText: { fontSize: 13 },
  seeAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 36 },
  seeAllText: { fontSize: 14 },
})
