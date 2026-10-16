/**
 * Credits — what you have, what you can buy, and what things cost.
 *
 * Credits pay for generations: each model has a price, taken when a generation starts and
 * given back if it fails. Packs are bought through the store (RevenueCat). The store
 * confirms a purchase to this screen at once, but the credits are added by the server when
 * RevenueCat tells it — so after a purchase the screen WAITS for the balance to rise,
 * rather than adding anything itself.
 *
 * What a pack is worth and what a model costs come from the server; the price you pay
 * comes from the store, in your own currency. See core/billing/packs.js.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator, Alert, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { userMessage } from '@core/errors'
import { refreshCredits, waitForCredits } from '@core/data/billing'
import { buyPackage, loadStorePackages, purchasesAvailable, startPurchases, syncPurchases } from '@core/platform/purchases'
import { joinPacks, formatCredits, describePrice } from '@core/billing/packs'

import { useBottomInset } from '../hooks/useBottomInset'
import { useCredits } from '../hooks/useCredits'
import { useTheme, space, font, layout } from '../theme'
import Screen, { ScreenHeader } from '../components/Screen'
import { Section, Button } from '../components/ui'
import { showError } from '../lib/alerts'

export default function CreditsScreen({ navigation }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const { userId } = useAuth()
  const credits = useCredits()

  /** What the store offers: loading, ready, unavailable (no key in this build) or failed. */
  const [store, setStore] = useState({ status: purchasesAvailable() ? 'loading' : 'unavailable', packages: [], message: null })
  const [buying, setBuying] = useState(null)         // the pack being bought
  const [waiting, setWaiting] = useState(false)      // bought; the credits have not arrived yet
  const [refreshing, setRefreshing] = useState(false)

  const loadStore = useCallback(async () => {
    if (!purchasesAvailable()) { setStore({ status: 'unavailable', packages: [], message: null }); return }
    try {
      await startPurchases(userId)
      setStore({ status: 'ready', packages: await loadStorePackages(), message: null })
    } catch (e) {
      setStore({ status: 'failed', packages: [], message: userMessage(e, 'The credit packs could not be loaded. Please try again.') })
    }
  }, [userId])

  useEffect(() => {
    loadStore()
    refreshCredits()
  }, [loadStore])

  const packs = useMemo(() => joinPacks(store.packages, credits.packs), [store.packages, credits.packs])
  const balance = credits.balance
  const busy = buying !== null || waiting

  const buy = useCallback(async pack => {
    if (busy) return
    const before = balance ?? 0
    setBuying(pack.id)
    try {
      const { cancelled } = await buyPackage(pack.native)
      if (cancelled) return
      setBuying(null)
      setWaiting(true)
      const arrived = await waitForCredits(before)
      Alert.alert(
        arrived ? 'Credits added' : 'Purchase complete',
        arrived
          ? `${formatCredits(pack.credits)} credits were added to your account.`
          : 'Your purchase went through. The credits can take a minute to appear — pull down to refresh.',
      )
    } catch (e) {
      showError('Purchase failed', e, 'The purchase could not be completed. Please try again.')
    } finally {
      setBuying(null)
      setWaiting(false)
    }
  }, [busy, balance])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    // A purchase made while the app was closed is re-sent to RevenueCat first, then the balance is read.
    await syncPurchases()
    await Promise.all([refreshCredits(), loadStore()])
    setRefreshing(false)
  }, [loadStore])

  const owes = balance !== null && balance < 0

  return (
    <Screen>
    <ScreenHeader title="Credits" size={22} onBack={() => navigation.goBack()} />
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      showsVerticalScrollIndicator={false}
    >
      <Section title="Your credits">
        <View style={styles.balanceBox}>
          {balance === null
            ? <ActivityIndicator color={colors.primary} />
            : <Text style={[styles.balance, font('bold'), { color: owes ? colors.danger : colors.textPrimary }]} accessibilityLabel={`${formatCredits(balance)} credits`}>{formatCredits(balance)}</Text>}
          <Text style={[styles.balanceUnit, { color: colors.textSecondary }]}>credits</Text>
          {waiting ? (
            <View style={styles.waiting}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.note, { color: colors.textSecondary }]}>Adding your credits…</Text>
            </View>
          ) : null}
          {owes ? (
            <Text style={[styles.note, { color: colors.danger }]}>
              Your balance is below zero because a purchase was refunded. Buy a pack to carry on.
            </Text>
          ) : null}
          {credits.loaded && !credits.enforced ? (
            <Text style={[styles.note, { color: colors.textTertiary }]}>Credits are not being charged yet.</Text>
          ) : null}
        </View>
      </Section>

      <Section title="Buy credits" footer="Credits never expire. If a generation fails, its credits come back.">
        {store.status === 'loading' ? (
          <View style={styles.padded}><ActivityIndicator color={colors.primary} /></View>
        ) : store.status === 'unavailable' ? (
          <Text style={[styles.message, { color: colors.textSecondary }]}>Buying credits is not set up in this version of the app.</Text>
        ) : store.status === 'failed' ? (
          <View style={styles.padded}>
            <Text style={[styles.message, { color: colors.danger }]}>{store.message}</Text>
            <Pressable onPress={loadStore} accessibilityRole="button"><Text style={[styles.link, font('semibold'), { color: colors.link }]}>Try again</Text></Pressable>
          </View>
        ) : packs.length === 0 ? (
          <Text style={[styles.message, { color: colors.textSecondary }]}>No credit packs are available right now.</Text>
        ) : (
          packs.map((pack, i) => (
            <PackRow key={pack.id} pack={pack} last={i === packs.length - 1} disabled={busy} busy={buying === pack.id} onBuy={() => buy(pack)} />
          ))
        )}
      </Section>

      {credits.prices.length > 0 ? (
        <Section title="What things cost">
          {credits.prices.map((p, i) => (
            <View key={p.model} style={[styles.costRow, i < credits.prices.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle }]}>
              <Text style={[styles.costName, { color: colors.textPrimary }]} numberOfLines={1}>{p.label || p.model}</Text>
              <Text style={[styles.costValue, { color: colors.textSecondary }]}>{describePrice(p)}</Text>
            </View>
          ))}
        </Section>
      ) : null}
    </ScrollView>
    </Screen>
  )
}

function PackRow({ pack, last, disabled, busy, onBuy }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.packRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle }]}>
      <View style={styles.packText}>
        <Text style={[styles.packTitle, { color: colors.textPrimary }]}>{pack.label}</Text>
        <Text style={[styles.packPrice, { color: colors.textSecondary }]}>{pack.price}</Text>
      </View>
      <Button title="Buy" size="sm" onPress={onBuy} disabled={disabled && !busy} loading={busy} style={styles.buy} />
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.pageGutter, paddingTop: space.sm, gap: space.sm },
  padded: { padding: space.lg, gap: space.md },
  balanceBox: { padding: space.xl, alignItems: 'center', gap: space.xs },
  balance: { fontSize: 44, letterSpacing: -1 },
  balanceUnit: { fontSize: 14, fontWeight: '600' },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  note: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: space.xs },
  message: { fontSize: 14, lineHeight: 20, padding: space.lg },
  link: { fontSize: 14, fontWeight: '600' },
  packRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  packText: { flex: 1, gap: 2 },
  packTitle: { fontSize: 16, fontWeight: '600' },
  packPrice: { fontSize: 14 },
  buy: { minWidth: 84 },
  costRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  costName: { flex: 1, fontSize: 15 },
  costValue: { fontSize: 14 },
})
