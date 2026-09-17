/**
 * Navigation shell.
 *
 * Two navigators and a gate between them: signed out gets the auth stack,
 * signed in gets the tab bar. Swapping the whole navigator rather than pushing
 * a modal is what makes the boundary real — there is no back gesture from the
 * app into a signed-out state, and no screen inside the tabs ever renders
 * without a session.
 *
 * ── The splash matters ───────────────────────────────────────────────────────
 *
 * On a cold start the session has to come out of the Keychain (native) or an
 * httpOnly cookie (web), which takes a moment. Rendering the sign-in screen
 * during that moment would flash it at every returning user on every launch, so
 * `initialising` gets its own state.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'
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

import SignInScreen from '../screens/auth/SignInScreen'
import SignUpScreen from '../screens/auth/SignUpScreen'
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen'

import { useQueueSync } from '../hooks/useQueueSync'
import { useCollectedResults } from '../hooks/useCollectedResults'
import { useAssetUrlRefresh } from '../hooks/useAssetUrlRefresh'
import { useTheme, space } from '../theme'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()
const AuthStack = createNativeStackNavigator()

function TabIcon({ glyph, color }) {
  return <Text style={{ fontSize: 20, color }}>{glyph}</Text>
}

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
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="InfluencersList" component={InfluencersScreen} options={{ title: 'Influencers' }} />
      <Stack.Screen
        name="InfluencerDetail"
        component={InfluencerDetailScreen}
        options={({ route }) => ({ title: route.params?.name || 'Studio' })}
      />
    </Stack.Navigator>
  )
}

function MainTabs() {
  const { colors } = useTheme()
  const { userId } = useAuth()

  // Keeps KIE moving jobs forward while the app is open; the badge and the
  // Queue screen learn about the results through Realtime.
  useQueueSync()
  // Results the server's worker saved while the app was open reach the gallery
  // without a reload.
  useCollectedResults()
  // Signed media URLs expire after ten minutes; this keeps the roster's fresh.
  useAssetUrlRefresh()

  const activeJobs = useActiveJobCount(userId)

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: { backgroundColor: colors.bgSecondary, borderTopColor: colors.borderSubtle },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          title: 'AI Influencer Studio',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabIcon glyph="🏠" color={color} />,
        }}
      />
      <Tab.Screen
        name="Influencers"
        component={InfluencersStack}
        options={{ headerShown: false, tabBarIcon: ({ color }) => <TabIcon glyph="👥" color={color} /> }}
      />
      <Tab.Screen
        name="Create"
        component={CreateScreen}
        options={{ tabBarIcon: ({ color }) => <TabIcon glyph="✨" color={color} /> }}
      />
      <Tab.Screen
        name="Queue"
        component={QueueScreen}
        options={{
          title: 'Queue',
          tabBarLabel: 'Queue',
          tabBarBadge: activeJobs > 0 ? activeJobs : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.brand, color: '#FFFFFF', fontSize: 11 },
          tabBarIcon: ({ color }) => <TabIcon glyph="🕓" color={color} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: ({ color }) => <TabIcon glyph="⚙️" color={color} /> }}
      />
    </Tab.Navigator>
  )
}

function AuthFlow() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
    </AuthStack.Navigator>
  )
}

function Splash({ message }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.splash, { backgroundColor: colors.bg }]}>
      <ActivityIndicator size="large" color={colors.brand} />
      {message ? (
        <Text style={[styles.splashText, { color: colors.textSecondary }]}>{message}</Text>
      ) : null}
    </View>
  )
}

/** A misconfigured build should say so, not fail as "cannot sign in". */
function ConfigError({ message }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.splash, { backgroundColor: colors.bg }]}>
      <Text style={[styles.configTitle, { color: colors.danger }]}>Not configured</Text>
      <Text style={[styles.splashText, { color: colors.textSecondary }]}>{message}</Text>
    </View>
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
      primary: colors.brand,
      background: colors.bg,
      card: colors.bgSecondary,
      text: colors.textPrimary,
      border: colors.borderSubtle,
    },
  }

  if (configError) return <ConfigError message={configError} />
  if (initialising) return <Splash />

  return (
    <NavigationContainer theme={navTheme}>
      {isSignedIn ? <MainTabs /> : <AuthFlow />}
    </NavigationContainer>
  )
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.lg },
  splashText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  configTitle: { fontSize: 18, fontWeight: '700' },
})
