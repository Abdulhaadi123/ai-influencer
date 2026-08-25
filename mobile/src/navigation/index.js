/**
 * Navigation shell — bottom tabs, the standard mobile pattern.
 *
 * The web app navigates with react-router and a top nav bar; that idiom does
 * not belong on a phone, so this is a native structure rather than a port:
 * a tab bar for the top-level destinations, with a native stack inside the
 * Influencers tab for drilling into one influencer.
 *
 * Home is the landing tab: opening straight onto a list gives no sense of what
 * the app is for, so Home explains the three features and routes into them.
 */

import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Text } from 'react-native'

import HomeScreen from '../screens/HomeScreen'
import InfluencersScreen from '../screens/InfluencersScreen'
import InfluencerDetailScreen from '../screens/InfluencerDetailScreen'
import CreateScreen from '../screens/CreateScreen'
import SettingsScreen from '../screens/SettingsScreen'
import { useTheme } from '../theme'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

/**
 * Emoji tab icons keep this dependency-free for now. Swapping in a proper icon
 * set (@expo/vector-icons) is a drop-in change to this one component.
 */
function TabIcon({ glyph, color }) {
  return <Text style={{ fontSize: 20, color }}>{glyph}</Text>
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

export default function RootNavigator() {
  const { colors, scheme } = useTheme()

  // Feed our palette into React Navigation so its own chrome matches.
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

  return (
    <NavigationContainer theme={navTheme}>
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
            // Full name in the header, short label in the tab bar — the full
            // one is wider than a quarter of a 375px screen and gets clipped.
            title: 'AI Influencer Studio',
            tabBarLabel: 'Home',
            tabBarIcon: ({ color }) => <TabIcon glyph="🏠" color={color} />,
          }}
        />
        <Tab.Screen
          name="Influencers"
          component={InfluencersStack}
          options={{
            headerShown: false,
            tabBarIcon: ({ color }) => <TabIcon glyph="👥" color={color} />,
          }}
        />
        <Tab.Screen
          name="Create"
          component={CreateScreen}
          options={{
            tabBarIcon: ({ color }) => <TabIcon glyph="✨" color={color} />,
          }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            tabBarIcon: ({ color }) => <TabIcon glyph="⚙️" color={color} />,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  )
}
