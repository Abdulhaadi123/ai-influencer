/**
 * Influencer detail — the studio for one influencer.
 *
 * The web app puts Profile / Videos / Motion Copy in a tab strip inside the
 * page. Same structure here, using a segmented control, which is the native
 * idiom for switching between sibling views.
 *
 * Motion Copy is live. Profile and Videos are ported in the next step, and say
 * so plainly rather than showing controls that do nothing.
 */

import { useMemo, useState } from 'react'
import { View, Text, ScrollView, Image, StyleSheet } from 'react-native'

import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Segmented } from '../components/ui'
import MotionCopyScreen from './MotionCopyScreen'

const TABS = [
  { label: 'Profile', value: 'profile' },
  { label: 'Videos', value: 'videos' },
  { label: 'Motion', value: 'motion' },
]

export default function InfluencerDetailScreen({ route }) {
  const { colors } = useTheme()
  const [influencers] = useInfluencers()
  const [tab, setTab] = useState('motion')

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

      {tab === 'motion' ? (
        <MotionCopyScreen influencer={influencer} />
      ) : (
        <ComingNext tab={tab} influencer={influencer} />
      )}
    </View>
  )
}

/**
 * Honest placeholder: states what is not built yet instead of rendering
 * controls that would do nothing.
 */
function ComingNext({ tab, influencer }) {
  const { colors } = useTheme()
  const label = tab === 'profile' ? 'Profile' : 'Videos'

  return (
    <ScrollView contentContainerStyle={styles.comingWrap}>
      {influencer.mainImage ? (
        <Image source={{ uri: influencer.mainImage }} style={styles.hero} resizeMode="cover" />
      ) : null}
      <Text style={[styles.comingTitle, { color: colors.textPrimary }]}>{influencer.name}</Text>
      <Text style={[styles.comingBody, { color: colors.textSecondary }]}>
        {label} is not ported to mobile yet — it is the next step of the migration.
        It works today in the web app, on the same data as this screen.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  tabBar: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },

  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  missingText: { fontSize: 15 },

  comingWrap: { padding: space.xl, alignItems: 'center', gap: space.md },
  hero: { width: 160, height: 213, borderRadius: radius.lg, marginBottom: space.sm },
  comingTitle: { fontSize: 20, fontWeight: '700' },
  comingBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
})
