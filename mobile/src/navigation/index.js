/**
 * Navigation shell.
 *
 * Two navigators and a gate between them: signed out gets the auth stack,
 * signed in gets the tab bar. Swapping the whole navigator rather than pushing
 * a modal is what makes the boundary real — there is no back gesture from the
 * app into a signed-out state, and no screen inside the tabs ever renders
 * without a session.
 *
 * No screen uses a native header: the design puts each title inside the page, so every
 * screen draws its own (`ScreenHeader`), and the tab bar is the floating pill
 * (`FloatingTabBar`) rather than a strip along the bottom.
 *
 * ── The splash matters ───────────────────────────────────────────────────────
 *
 * On a cold start the session has to come out of the Keychain (native) or an
 * httpOnly cookie (web), which takes a moment. Rendering the sign-in screen
 * during that moment would flash it at every returning user on every launch, so
 * `initialising` gets its own state — and shows the logo, which is what the design's
 * splash screens are.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Animated, Easing, StyleSheet } from 'react-native'
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'

import { useAuth } from '@core/auth/AuthContext'
import { countActive, subscribe as subscribeToJobs } from '@core/data/jobs'

import HomeScreen from '../screens/HomeScreen'
import InfluencersScreen from '../screens/InfluencersScreen'
import InfluencerDetailScreen from '../screens/InfluencerDetailScreen'
import CreateScreen from '../screens/CreateScreen'
import QueueScreen from '../screens/QueueScreen'
import SettingsScreen from '../screens/SettingsScreen'
import CreditsScreen from '../screens/CreditsScreen'

import WelcomeScreen from '../screens/auth/WelcomeScreen'
import SignInScreen from '../screens/auth/SignInScreen'
import SignUpScreen from '../screens/auth/SignUpScreen'
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen'

import { useQueueSync } from '../hooks/useQueueSync'
import { useCollectedResults, usePollingWhileForeground } from '../hooks/useCollectedResults'
import { useAssetUrlRefresh } from '../hooks/useAssetUrlRefresh'
import { useBilling } from '../hooks/useBilling'
import FloatingTabBar from './FloatingTabBar'
import Screen from '../components/Screen'
import { Logo, LogoMark } from '../components/brand'
import { navigationRef } from './ref'
import { useTheme, space, font } from '../theme'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()
const AuthStack = createNativeStackNavigator()

/**
 * Live count of running jobs for the Queue badge.
 *
 * Pushed rather than polled. The count used to be re-read from device storage
 * every three seconds; against a database that would be a request every three
 * seconds per client, forever, almost always returning the same number.
 * Postgres tells us when something changes instead.
 */
function useActiveJobCount(userId) {
  const [n, setN] = useState(0)

  const recount = useCallback(async () => {
    if (!userId) { setN(0); return }
    try { setN(await countActive()) } catch { /* badge only; never worth surfacing */ }
  }, [userId])

  useEffect(() => {
    recount()
    if (!userId) return
    return subscribeToJobs(userId, recount)
  }, [userId, recount])

  return n
}

function InfluencersStack() {
  const { colors } = useTheme()
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="InfluencersList" component={InfluencersScreen} />
      <Stack.Screen name="InfluencerDetail" component={InfluencerDetailScreen} />
    </Stack.Navigator>
  )
}

function MainTabs() {
  const { userId } = useAuth()

  // Keeps KIE moving jobs forward while the app is open; the badge and the
  // Queue screen learn about the results through Realtime.
  useQueueSync()
  // Results the server's worker saved while the app was open reach the gallery
  // without a reload.
  useCollectedResults()
  usePollingWhileForeground()
  // Signed media URLs expire after ten minutes; this keeps the roster's fresh.
  useAssetUrlRefresh()
  // Who is signed in to the store, the balance, and the "not enough credits" alert.
  useBilling()

  const activeJobs = useActiveJobCount(userId)

  return (
    <Tab.Navigator
      tabBar={props => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
      <Tab.Screen name="Influencers" component={InfluencersStack} options={{ tabBarLabel: 'Influencers' }} />
      <Tab.Screen name="Create" component={CreateScreen} options={{ tabBarLabel: 'Create' }} />
      <Tab.Screen
        name="Queue"
        component={QueueScreen}
        options={{ tabBarLabel: 'Queue', tabBarBadge: activeJobs > 0 ? activeJobs : undefined }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: 'Settings' }} />
    </Tab.Navigator>
  )
}

/**
 * Signed in: the tabs, and the screens that open over them. Credits is reached from the
 * header chip, from Settings, and from the "not enough credits" alert.
 */
function SignedIn() {
  const { colors } = useTheme()
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen name="Credits" component={CreditsScreen} />
    </Stack.Navigator>
  )
}

function AuthFlow() {
  const { colors } = useTheme()
  const { notice } = useAuth()
  // A session that ended is explained on the sign-in screen, so go straight there; everyone
  // else starts on the welcome screen. Read once: moving between the screens is the person's.
  const initial = useRef(notice ? 'SignIn' : 'Welcome').current
  return (
    <AuthStack.Navigator
      initialRouteName={initial}
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
    >
      <AuthStack.Screen name="Welcome" component={WelcomeScreen} />
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
    </AuthStack.Navigator>
  )
}

/** The design's splash: the mark on white, which then settles into the full logo. */
function Splash({ message }) {
  const { colors } = useTheme()
  const appear = useRef(new Animated.Value(0)).current
  const settle = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.sequence([
      Animated.timing(appear, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(250),
      Animated.timing(settle, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
    ]).start()
  }, [appear, settle])

  return (
    <Screen>
      <View style={styles.splash}>
        <Animated.View style={{ opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }}>
          <View>
            <Animated.View style={{ opacity: settle.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), position: 'absolute', alignSelf: 'center' }}>
              <LogoMark height={104} />
            </Animated.View>
            <Animated.View style={{ opacity: settle }}>
              <Logo height={64} />
            </Animated.View>
          </View>
        </Animated.View>
        {message ? (
          <Text style={[styles.splashText, font('regular'), { color: colors.textSecondary }]}>{message}</Text>
        ) : null}
      </View>
    </Screen>
  )
}

/** A misconfigured build should say so, not fail as "cannot sign in". */
function ConfigError({ message }) {
  const { colors } = useTheme()
  return (
    <Screen>
      <View style={styles.splash}>
        <Text style={[styles.configTitle, font('bold'), { color: colors.danger }]}>Not configured</Text>
        <Text style={[styles.splashText, { color: colors.textSecondary }]}>{message}</Text>
      </View>
    </Screen>
  )
}

export default function RootNavigator() {
  const { colors, scheme } = useTheme()
  const { isSignedIn, initialising, configError } = useAuth()

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.bg,
      card: colors.bgSecondary,
      text: colors.textPrimary,
      border: colors.borderSubtle,
    },
  }

  if (configError) return <ConfigError message={configError} />
  if (initialising) return <Splash />

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      {isSignedIn ? <SignedIn /> : <AuthFlow />}
    </NavigationContainer>
  )
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.lg },
  splashText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  configTitle: { fontSize: 20 },
})
