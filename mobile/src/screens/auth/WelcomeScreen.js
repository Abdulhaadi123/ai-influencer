/**
 * Welcome — the first screen a signed-out person sees.
 *
 * A full-bleed picture with a white sheet rising over its lower part: "Welcome to Influenza
 * Ai", then the two ways in. The design offers Google and Facebook as well; this app has
 * email-and-password accounts only, so those are not drawn — a button that cannot sign anyone
 * in is worse than no button.
 */

import { View, Text, Image, StyleSheet } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useAuth } from '@core/auth/AuthContext'

import { useTheme, space, font, layout } from '../../theme'
import { Button } from '../../components/ui'
import { LogoMark } from '../../components/brand'
import { welcomeHero } from '../../assets/heroes'
import { FormNotice } from './parts'

export default function WelcomeScreen({ navigation }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { notice } = useAuth()

  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      {welcomeHero ? (
        <Image source={welcomeHero} style={styles.hero} resizeMode="cover" />
      ) : (
        // The picture's colours — a magenta wash on the left, blue on the right — until it is added.
        <LinearGradient
          colors={['#D653C6', '#8A5CF0', '#4D6BEF']}
          start={{ x: 0, y: 0.1 }} end={{ x: 1, y: 0.9 }}
          style={[styles.hero, styles.heroFallback]}
        >
          <View style={{ marginTop: insets.top + space.xxl * 2 }}>
            <LogoMark height={96} color="#FFFFFF" />
          </View>
        </LinearGradient>
      )}

      <View style={[styles.sheet, { backgroundColor: colors.bg, paddingBottom: insets.bottom + space.xl }]}>
        <Text style={[styles.welcome, font('regular'), { color: colors.textPrimary }]}>Welcome to</Text>
        <Text style={[styles.brand, font('bold'), { color: colors.textPrimary }]} accessibilityRole="header">Influenza Ai</Text>

        <View style={styles.notice}><FormNotice>{notice}</FormNotice></View>

        <View style={styles.buttons}>
          <Button title="Sign in with email" variant="dark" onPress={() => navigation.navigate('SignIn')} />
          <Button title="Create an account" variant="neutral" onPress={() => navigation.navigate('SignUp')} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  hero: { ...StyleSheet.absoluteFillObject, bottom: '34%', width: '100%', height: undefined },
  heroFallback: { alignItems: 'center' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 48, borderTopRightRadius: 48,
    paddingTop: space.xxl + space.sm, paddingHorizontal: layout.gutter + 16, alignItems: 'center',
  },
  welcome: { fontSize: 17 },
  brand: { fontSize: 31, letterSpacing: -0.6, marginTop: 2, marginBottom: space.xl },
  notice: { alignSelf: 'stretch' },
  buttons: { alignSelf: 'stretch', gap: space.md },
})
