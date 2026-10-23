/**
 * Influencer detail — the studio for one influencer.
 *
 * Profile / Videos / Motion / Gallery in the rounded pill bar the design puts under the
 * influencer's name. All four tabs are live. Gallery reads back the generation history that
 * Videos and Motion Copy write, so results outlive the screen that made them.
 */

import { useMemo, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'

import { useInfluencers } from '@core/store'

import { isServable } from '../lib/seedMedia'
import MediaImage from '../components/MediaImage'
import { useTheme, space, layout } from '../theme'
import Screen, { ScreenHeader } from '../components/Screen'
import { Segmented } from '../components/ui'
import GalleryTab from './GalleryTab'
import MotionCopyScreen from './MotionCopyScreen'
import ProfileTab from './ProfileTab'
import VideosTab from './VideosTab'

const TABS = [
  { label: 'Profile', value: 'profile' },
  { label: 'Videos', value: 'videos' },
  { label: 'Motion', value: 'motion' },
  { label: 'Gallery', value: 'gallery' },
]

export default function InfluencerDetailScreen({ route, navigation }) {
  const { colors } = useTheme()
  const roster = useInfluencers()
  const [influencers] = roster
  const [tab, setTab] = useState('profile')

  const id = route?.params?.id
  // Read live from the store so edits elsewhere show up here.
  const influencer = useMemo(
    () => (influencers || []).find(i => String(i.id) === String(id)),
    [influencers, id]
  )
  const goBack = () => navigation.goBack()

  if (!influencer) {
    return (
      <Screen>
        <ScreenHeader onBack={goBack} />
        <View style={styles.missing}>
          {roster.loading
            ? <ActivityIndicator size="large" color={colors.primary} />
            : <Text style={[styles.missingText, { color: colors.textSecondary }]}>This influencer could not be found.</Text>}
        </View>
      </Screen>
    )
  }

  const avatar = isServable(influencer.mainImage) ? influencer.mainImage : null

  return (
    <Screen>
      <ScreenHeader
        onBack={goBack}
        title={influencer.name || 'Studio'}
        size={16}
        right={avatar ? <MediaImage uri={avatar} style={styles.avatar} contentFit="cover" /> : null}
      />

      <View style={styles.tabs}>
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </View>

      <View style={styles.flex}>
        {tab === 'profile' ? (
          <ProfileTab influencer={influencer} navigation={navigation} />
        ) : tab === 'videos' ? (
          <VideosTab influencer={influencer} />
        ) : tab === 'motion' ? (
          <MotionCopyScreen influencer={influencer} />
        ) : (
          <GalleryTab influencer={influencer} />
        )}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabs: { paddingHorizontal: layout.pageGutter, paddingBottom: space.md },
  avatar: { width: 34, height: 34, borderRadius: 9 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  missingText: { fontSize: 15 },
})
