/**
 * Influencers — the native list of everyone in the shared store.
 *
 * Reads `useInfluencers()` from @core/store, the exact hook the web app's
 * Influencers page uses, so both platforms show the same data from the same
 * source. The per-influencer studio (Profile / Videos / Motion Copy) is ported
 * in a later step; this screen is the list and navigation entry point.
 */

import { useMemo } from 'react'
import { View, Text, Image, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { mediaSource } from '../lib/seedMedia'

import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'

export default function InfluencersScreen({ navigation }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const roster = useInfluencers()
  const [influencers] = roster

  // Stable ordering so the list doesn't reshuffle between renders.
  const data = useMemo(
    () => [...(influencers || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [influencers]
  )

  if (!data.length && roster.loading) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    )
  }

  // Not "No influencers yet": a load that failed is not an empty roster, and
  // that screen invited people to create duplicates of what they already had.
  if (!data.length && roster.error) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Unable to load influencers</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{roster.error}</Text>
        <Pressable
          onPress={roster.refresh}
          accessibilityRole="button"
          style={({ pressed }) => [styles.emptyCta, { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={styles.emptyCtaText}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  if (!data.length) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg }]}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.brandSoft }]}>
          <Text style={styles.emptyGlyph}>✦</Text>
        </View>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No influencers yet</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Create your first influencer to get started.
        </Text>
        <Pressable
          onPress={() => navigation?.navigate?.('Create')}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.emptyCta,
            { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.emptyCtaText}>Create influencer</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
      data={data}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => (
        <InfluencerCard
          influencer={item}
          onPress={() => navigation?.navigate?.('InfluencerDetail', { id: item.id, name: item.name })}
        />
      )}
    />
  )
}

function InfluencerCard({ influencer, onPress }) {
  const { colors } = useTheme()
  // Resolve rather than trust the string: seed avatars are web-origin paths
  // that render blank, and must fall through to the letter placeholder.
  const image = mediaSource(influencer.mainImage || influencer.image)
  const subtitle = influencer.niche || influencer.gender || '—'

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.borderSubtle }}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.borderSubtle,
          opacity: pressed ? 0.9 : 1,
        },
      ]}
    >
      {image ? (
        <Image source={image} style={styles.avatar} resizeMode="cover" />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.brandSoft }]}>
          <Text style={[styles.avatarLetter, { color: colors.brand }]}>
            {(influencer.name || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}

      <View style={styles.cardText}>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {influencer.name || 'Unnamed'}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <Text style={[styles.chevron, { color: colors.textTertiary }]}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: { padding: space.lg, gap: space.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 52, height: 52, borderRadius: radius.md },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 20, fontWeight: '700' },
  cardText: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13 },
  chevron: { fontSize: 24, lineHeight: 26, paddingRight: space.xs },

  emptyIcon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.lg,
  },
  emptyGlyph: { fontSize: 28 },
  emptyCta: {
    marginTop: space.xl,
    paddingVertical: space.md, paddingHorizontal: space.xl,
    borderRadius: radius.md,
  },
  emptyCtaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.sm },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
})
