/**
 * Home — the app's landing screen.
 *
 * Opening straight onto a list of influencers gives no sense of what the app
 * is for. This explains the three things it does, shows what you already have,
 * and points at the obvious next action.
 *
 * It reads live from the shared store, so the counts are real rather than
 * decorative.
 */

import { useMemo } from 'react'
import { View, Text, ScrollView, Image, Pressable, StyleSheet } from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { isServable, mediaSource } from '../lib/seedMedia'
import { LinearGradient } from 'expo-linear-gradient'

import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'

const FEATURES = [
  {
    icon: '✦',
    title: 'Create an influencer',
    body: 'Describe them, or upload a photo and choose exactly what to copy — face, hair, build, outfit. Regenerate until the look is right.',
    tab: 'Create',
  },
  {
    icon: '🎬',
    title: 'Promote a product',
    body: 'Add a product image and a script. Your influencer presents it to camera, speaking in the voice you choose.',
    tab: 'Influencers',
    hint: 'Open an influencer → Videos',
  },
  {
    icon: '🕺',
    title: 'Copy a motion',
    body: 'Give it any video and your influencer performs the same movement and expression, staying recognisably themselves.',
    tab: 'Influencers',
    hint: 'Open an influencer → Motion',
  },
]

export default function HomeScreen({ navigation }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const [influencers] = useInfluencers()

  const recent = useMemo(
    () => (influencers || []).filter(i => isServable(i.mainImage)).slice(0, 6),
    [influencers]
  )
  const count = (influencers || []).length

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
    >
      {/* Masthead */}
      <LinearGradient
        colors={colors.brandGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <Text style={styles.heroTitle}>AI Influencer Studio</Text>
        <Text style={styles.heroSub}>
          Build a virtual influencer, then have them promote products and copy
          any motion — from your phone.
        </Text>
      </LinearGradient>

      {/* What you already have */}
      <Pressable
        onPress={() => navigation.navigate('Influencers')}
        style={({ pressed }) => [
          styles.statCard,
          { backgroundColor: colors.surface, borderColor: colors.borderSubtle, opacity: pressed ? 0.9 : 1 },
        ]}
      >
        <View style={styles.statTop}>
          <View>
            <Text style={[styles.statNumber, { color: colors.textPrimary }]}>{count}</Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
              {count === 1 ? 'influencer' : 'influencers'} ready to use
            </Text>
          </View>
          <Text style={[styles.chevron, { color: colors.textTertiary }]}>›</Text>
        </View>

        {recent.length ? (
          <View style={styles.avatarRow}>
            {recent.map(inf => (
              <Image
                key={inf.id}
                source={mediaSource(inf.mainImage)}
                style={[styles.avatar, { borderColor: colors.surface }]}
                resizeMode="cover"
              />
            ))}
          </View>
        ) : null}
      </Pressable>

      {/* The three things it does */}
      <Text style={[styles.sectionHeading, { color: colors.textTertiary }]}>WHAT YOU CAN DO</Text>

      {FEATURES.map(f => (
        <Pressable
          key={f.title}
          onPress={() => navigation.navigate(f.tab)}
          style={({ pressed }) => [
            styles.feature,
            { backgroundColor: colors.surface, borderColor: colors.borderSubtle, opacity: pressed ? 0.9 : 1 },
          ]}
        >
          <View style={[styles.featureIcon, { backgroundColor: colors.brandSoft }]}>
            <Text style={styles.featureIconText}>{f.icon}</Text>
          </View>
          <View style={styles.featureText}>
            <Text style={[styles.featureTitle, { color: colors.textPrimary }]}>{f.title}</Text>
            <Text style={[styles.featureBody, { color: colors.textSecondary }]}>{f.body}</Text>
            {f.hint ? (
              <Text style={[styles.featureHint, { color: colors.brandDeep }]}>{f.hint}</Text>
            ) : null}
          </View>
        </Pressable>
      ))}

      <Text style={[styles.footnote, { color: colors.textTertiary }]}>
        Generating uses the studio's shared credits. Check Settings if anything
        reports the engine as offline.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg },

  hero: { borderRadius: radius.lg, padding: space.xl, marginBottom: space.lg },
  heroTitle: { color: '#FFFFFF', fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginBottom: space.sm },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 14, lineHeight: 20 },

  statCard: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, marginBottom: space.xl, gap: space.md },
  statTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statNumber: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { fontSize: 14, marginTop: 2 },
  chevron: { fontSize: 26, lineHeight: 28 },
  avatarRow: { flexDirection: 'row' },
  avatar: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, marginRight: -10 },

  sectionHeading: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginBottom: space.md, marginLeft: space.xs },

  feature: {
    flexDirection: 'row', gap: space.md, alignItems: 'flex-start',
    borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg, marginBottom: space.md,
  },
  featureIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  featureIconText: { fontSize: 19 },
  featureText: { flex: 1, gap: 3 },
  featureTitle: { fontSize: 16, fontWeight: '700' },
  featureBody: { fontSize: 13.5, lineHeight: 19 },
  featureHint: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },

  footnote: { fontSize: 12, lineHeight: 18, marginTop: space.md, marginHorizontal: space.xs },
})
