/**
 * Home — the app's landing screen.
 *
 * Opening straight onto a list of influencers gives no sense of what the app
 * is for. This explains the three things it does, shows how many influencers
 * you have, and points at the obvious next action.
 *
 * It reads live from the shared store, so the count is real rather than
 * decorative.
 */

import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'

import { useInfluencers } from '@core/store'

import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius, font, layout } from '../theme'
import Screen, { ScreenHeader } from '../components/Screen'
import { GlassCard } from '../components/ui'
import { Logo } from '../components/brand'
import CreditsChip from '../components/CreditsChip'
import Icon from '../components/icons'

const FEATURES = [
  {
    icon: 'video',
    title: 'Product\nVideos',
    body: 'Create videos of your influencer presenting a product with a script and voice of your choice',
    tab: 'Influencers',
    hint: 'Open an influencer and choose Videos',
  },
  {
    icon: 'motion',
    title: 'Motion\nCopy',
    body: 'Apply the movements and expressions from any video to your influencer',
    tab: 'Influencers',
    hint: 'Open an influencer and choose Motion',
  },
]

export default function HomeScreen({ navigation }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const roster = useInfluencers()
  const [influencers] = roster
  const { loading, error, refresh } = roster
  const count = (influencers || []).length

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader gutter={layout.gutter} left={<Logo height={26} />} right={<CreditsChip />} />

        <View style={styles.body}>
          {/* Masthead */}
          <LinearGradient
            colors={colors.heroGradient}
            start={{ x: 0, y: 0.2 }}
            end={{ x: 1, y: 0.8 }}
            style={styles.hero}
          >
            <View style={styles.heroText}>
              <Text style={[styles.heroTitle, font('bold')]}>AI Influencer{'\n'}Studio</Text>
              <Text style={[styles.heroSub, font('regular')]}>
                Create AI influencers, produce product videos and bring them to life with motion
              </Text>
            </View>
            <View style={styles.heroSparkle} pointerEvents="none">
              <Icon name="sparkle" size={96} color="rgba(255,255,255,0.28)" />
            </View>
          </LinearGradient>

          {/* A failed load used to read as "0 influencers" — to someone who has ten. */}
          {error ? (
            <View style={[styles.errorBanner, { borderColor: colors.danger, backgroundColor: colors.dangerSoft }]}>
              <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
              <Pressable onPress={refresh} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.retry, font('semibold'), { color: colors.link }]}>Try again</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={[styles.heading, font('medium'), { color: colors.textPrimary }]}>Get Started</Text>

          <Pressable
            onPress={() => navigation.navigate('Create')}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
          >
            <GlassCard radiusSize={28}>
              <View style={styles.createCard}>
                <View style={styles.flex}>
                  <Text style={[styles.cardTitle, font('regular'), { color: colors.textPrimary }]}>Create{'\n'}Influencer</Text>
                  <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
                    Generate a unique influencer from a description or reference photo and choose which features to match
                  </Text>
                </View>
                <View style={[styles.iconBubble, { backgroundColor: colors.glass, borderColor: colors.glassEdge }]}>
                  <Icon name="sparkle" size={26} color={colors.primary} />
                </View>
              </View>
            </GlassCard>
          </Pressable>

          <View style={styles.pair}>
            {FEATURES.map(f => (
              <Pressable
                key={f.icon}
                onPress={() => navigation.navigate(f.tab)}
                accessibilityRole="button"
                accessibilityHint={f.hint}
                style={({ pressed }) => [styles.flex, { opacity: pressed ? 0.85 : 1 }]}
              >
                <GlassCard tone="surface" style={styles.featureCard}>
                  <View style={[styles.smallBubble, { backgroundColor: colors.glass }]}>
                    <Icon name={f.icon} size={20} color={colors.primary} />
                  </View>
                  <Text style={[styles.cardTitle, font('regular'), { color: colors.textPrimary }]}>{f.title}</Text>
                  <Text style={[styles.cardBody, { color: colors.textSecondary }]}>{f.body}</Text>
                </GlassCard>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={() => navigation.navigate('Influencers')}
            accessibilityRole="button"
            accessibilityLabel={`${count} ${count === 1 ? 'influencer' : 'influencers'}. Open the list.`}
            style={({ pressed }) => [styles.total, { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1 }]}
          >
            <Text style={[styles.totalLabel, font('regular')]}>Total{'\n'}Influencers</Text>
            {loading && count === 0 ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={[styles.totalNumber, font('medium')]}>{String(count).padStart(2, '0')}</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { flexGrow: 1 },
  body: { paddingHorizontal: layout.gutter, gap: space.lg },
  flex: { flex: 1 },

  hero: { borderRadius: 28, paddingVertical: space.xl, paddingHorizontal: space.xl, minHeight: 138, overflow: 'hidden', justifyContent: 'center' },
  heroText: { maxWidth: '78%', gap: space.sm },
  heroTitle: { color: '#FFFFFF', fontSize: 28, lineHeight: 32, letterSpacing: -0.6 },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 12, lineHeight: 17 },
  heroSparkle: { position: 'absolute', right: -6, bottom: -4 },

  errorBanner: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  errorText: { fontSize: 13.5, lineHeight: 19 },
  retry: { fontSize: 14 },

  heading: { fontSize: 16, marginTop: space.sm, marginLeft: space.sm },

  createCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.xl },
  iconBubble: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 24, lineHeight: 28, letterSpacing: -0.4 },
  cardBody: { fontSize: 11.5, lineHeight: 16, marginTop: space.sm },

  pair: { flexDirection: 'row', gap: space.lg },
  featureCard: { padding: space.lg + 2, minHeight: 176, borderRadius: 26 },
  smallBubble: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: space.md },

  total: { borderRadius: 22, paddingHorizontal: space.xl, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 70 },
  totalLabel: { color: '#FFFFFF', fontSize: 15, lineHeight: 19 },
  totalNumber: { color: '#FFFFFF', fontSize: 38, letterSpacing: -0.8 },
})
