/**
 * Influencer detail — the studio for one influencer.
 *
 * Profile / Videos / Motion / Gallery in the rounded pill bar the design puts under the
 * influencer's name. All four tabs are live. Gallery reads back the generation history that
 * Videos and Motion Copy write, so results outlive the screen that made them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'

import { useInfluencers } from '@core/store'

import { isServable } from '../lib/seedMedia'
import { galleryNotices, useUnseenInGallery } from '../lib/galleryNotice'
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

  // Asked to open a tab: the "Saved to Gallery" toast's View button opens the Gallery (navigation/ref.js).
  const wantedTab = route?.params?.tab
  const askedAt = route?.params?.at
  useEffect(() => {
    if (wantedTab && TABS.some(t => t.value === wantedTab)) setTab(wantedTab)
  }, [wantedTab, askedAt])

  // While this influencer's Gallery is on screen a new result simply appears there, so nothing is
  // announced about it; and opening it counts everything in it as seen (lib/galleryNotice.js).
  useFocusEffect(useCallback(() => {
    galleryNotices.setViewing(id && tab === 'gallery' ? id : null)
    return () => galleryNotices.setViewing(null)
  }, [id, tab]))

  // Results filed here since the Gallery was last open, as a pulsing count on its tab.
  const unseen = useUnseenInGallery(id)
  const tabs = useMemo(
    () => TABS.map(t => (t.value === 'gallery' && tab !== 'gallery' ? { ...t, badge: unseen } : t)),
    [unseen, tab],
  )

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

  // A small header avatar: the main image's preview when the server has one.
  const avatar = [influencer.mainThumb, influencer.mainImage].find(isServable) ?? null

  return (
    <Screen>
      <ScreenHeader
        onBack={goBack}
        title={influencer.name || 'Studio'}
        size={16}
        right={avatar ? <MediaImage uri={avatar} style={styles.avatar} contentFit="cover" /> : null}
      />

      <View style={styles.tabs}>
        <Segmented options={tabs} value={tab} onChange={setTab} />
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
