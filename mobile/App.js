import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'

import { AuthProvider } from '@core/auth/AuthContext'
import { StoreProvider } from '@core/store'

import { ThemeProvider, useTheme } from './src/theme'
import RootNavigator from './src/navigation'
import ErrorBoundary from './src/components/ErrorBoundary'

/**
 * Provider order is load-bearing.
 *
 * AuthProvider must wrap StoreProvider: the store reads the signed-in user to
 * decide whose data to load, and clears itself when that user changes. Nesting
 * them the other way round would leave the store fetching before it knows who
 * is asking — and, worse, holding one user's roster while another signs in.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StoreProvider>
          <ThemeProvider>
            <ErrorBoundary>
              <ThemedApp />
            </ErrorBoundary>
          </ThemeProvider>
        </StoreProvider>
      </AuthProvider>
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
