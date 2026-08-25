import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'

// The shared store — the SAME React context the web app runs, from ../src/core.
import { StoreProvider } from '@core/store'

import { ThemeProvider, useTheme } from './src/theme'
import RootNavigator from './src/navigation'

export default function App() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <ThemeProvider>
          <ThemedApp />
        </ThemeProvider>
      </StoreProvider>
    </SafeAreaProvider>
  )
}

/**
 * Split out so the status bar can read the resolved theme — `useTheme` has to
 * be called below <ThemeProvider>, not alongside it.
 */
function ThemedApp() {
  const { scheme } = useTheme()
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
    </>
  )
}
