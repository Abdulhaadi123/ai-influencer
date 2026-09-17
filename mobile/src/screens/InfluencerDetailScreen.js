/**
 * Influencer detail — the studio for one influencer.
 *
 * The web app puts Profile / Videos / Motion Copy in a tab strip inside the
 * page. Same structure here, using a segmented control, which is the native
 * idiom for switching between sibling views.
 *
 * All four tabs are live. Gallery reads back the generation history that
 * Videos and Motion Copy write, so results outlive the screen that made them.
 */

import { useMemo, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'

import { useInfluencers } from '@core/store'

import { useTheme, space } from '../theme'
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

  if (!influencer && roster.loading) {
    return (
      <View style={[styles.missing, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    )
  }

  if (!influencer) {
    return (
      <View style={[styles.missing, { backgroundColor: colors.bg }]}>
        <Text style={[styles.missingText, { color: colors.textSecondary }]}>
          This influencer could not be found.
        </Text>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.tabBar, { borderBottomColor: colors.borderSubtle }]}>
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </View>

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
  )
}

const styles = StyleSheet.create({
  tabBar: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },

  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  missingText: { fontSize: 15 },

})
