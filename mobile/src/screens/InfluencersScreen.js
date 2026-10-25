/**
 * Influencers — the list of everyone in the shared store.
 *
 * Reads `useInfluencers()` from @core/store. The per-influencer studio (Profile / Videos /
 * Motion / Gallery) is InfluencerDetailScreen; this screen is the list and its way in.
 */

import { useMemo } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'

import { useInfluencers } from '@core/store'

import { useBottomInset } from '../hooks/useBottomInset'
import { isServable } from '../lib/seedMedia'
import MediaImage from '../components/MediaImage'
import { useTheme, space, font, layout } from '../theme'
import Screen, { ScreenHeader } from '../components/Screen'
import { GlassCard, EmptyState } from '../components/ui'
import CreditsChip from '../components/CreditsChip'

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

  const header = <ScreenHeader title="Influencers" size={22} right={<CreditsChip />} />

  if (!data.length && roster.loading) {
    return (
      <Screen>
        {header}
        <View style={styles.centre}><ActivityIndicator size="large" color={colors.primary} /></View>
      </Screen>
    )
  }

  // Not "No influencers yet": a load that failed is not an empty roster, and
  // that screen invited people to create duplicates of what they already had.
  if (!data.length && roster.error) {
    return (
      <Screen>
        {header}
        <EmptyState
          icon="close"
          title="Unable to load influencers"
          body={roster.error}
          actionTitle="Try again"
          onAction={roster.refresh}
        />
      </Screen>
    )
  }

  if (!data.length) {
    return (
      <Screen>
        {header}
        <EmptyState
          icon="sparkle"
          title="No influencers yet"
          body="Create your first influencer to get started."
          actionTitle="Create influencer"
          onAction={() => navigation?.navigate?.('Create')}
        />
      </Screen>
    )
  }

  return (
    <Screen>
      <FlatList
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
        data={data}
        keyExtractor={item => String(item.id)}
        ListHeaderComponent={header}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <InfluencerCard
            influencer={item}
            onPress={() => navigation?.navigate?.('InfluencerDetail', { id: item.id, name: item.name })}
          />
        )}
      />
    </Screen>
  )
}

function InfluencerCard({ influencer, onPress }) {
  // Resolve rather than trust the string: seed avatars are web-origin paths
  // that render blank, and must fall through to the letter placeholder.
  // The main image's small preview when the server has one: a 58-point square needs no 2K picture.
  const image = influencer.mainThumb || influencer.mainImage || influencer.image
  const showImage = isServable(image)
  const subtitle = influencer.niche || influencer.gender || '—'

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${influencer.name || 'Unnamed'}, ${subtitle}`}
      style={({ pressed }) => [styles.cardWrap, { opacity: pressed ? 0.88 : 1 }]}
    >
      <GlassCard tone="strong" radiusSize={22}>
        <View style={styles.card}>
          <View style={styles.cardText}>
            <Text style={[styles.name, font('regular')]} numberOfLines={1}>{influencer.name || 'Unnamed'}</Text>
            <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
          </View>
          {showImage ? (
            <MediaImage uri={image} style={styles.avatar} contentFit="cover" />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={[styles.avatarLetter, font('bold')]}>{(influencer.name || '?').charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>
      </GlassCard>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flexGrow: 1 },
  cardWrap: { paddingHorizontal: layout.pageGutter - 4, marginBottom: space.md + 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingLeft: space.lg + 2, paddingRight: space.md },
  cardText: { flex: 1, gap: 2 },
  name: { color: '#FFFFFF', fontSize: 22, letterSpacing: -0.3 },
  subtitle: { color: 'rgba(255,255,255,0.62)', fontSize: 12 },
  avatar: { width: 58, height: 58, borderRadius: 14 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)' },
  avatarLetter: { color: '#FFFFFF', fontSize: 22 },
})
