/**
 * Influencer detail — the studio for one influencer.
 *
 * The web app puts Profile / Videos / Motion Copy in a tab strip inside the
 * page. Same structure here, using a segmented control, which is the native
 * idiom for switching between sibling views.
 *
 * All three tabs are live.
 */

import { useMemo, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'

import { useInfluencers } from '@core/store'

import { useTheme, space } from '../theme'
import { Segmented } from '../components/ui'
import MotionCopyScreen from './MotionCopyScreen'
import ProfileTab from './ProfileTab'
import VideosTab from './VideosTab'

const TABS = [
  { label: 'Profile', value: 'profile' },
  { label: 'Videos', value: 'videos' },
  { label: 'Motion', value: 'motion' },
]

export default function InfluencerDetailScreen({ route }) {
  const { colors } = useTheme()
  const [influencers] = useInfluencers()
  const [tab, setTab] = useState('profile')

  const id = route?.params?.id
  // Read live from the store so edits elsewhere show up here.
  const influencer = useMemo(
    () => (influencers || []).find(i => String(i.id) === String(id)),
    [influencers, id]
  )

  if (!influencer) {
    return (
      <View style={[styles.missing, { backgroundColor: colors.bg }]}>
        <Text style={[styles.missingText, { color: colors.textSecondary }]}>
          That influencer no longer exists.
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
        <ProfileTab influencer={influencer} />
      ) : tab === 'videos' ? (
        <VideosTab influencer={influencer} />
      ) : (
        <MotionCopyScreen influencer={influencer} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  tabBar: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },

  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  missingText: { fontSize: 15 },

})
