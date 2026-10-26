/**
 * The foot of a list that is fetched a page at a time (the Queue, the Gallery).
 *
 * The next page normally arrives by itself as the list is scrolled near its end.
 * This says what is happening down there: a spinner while a page is on its way;
 * what went wrong, with Try again, when one failed (the list stops asking by
 * itself until then, rather than retrying in a loop); and otherwise how much is
 * loaded, with Load more for a list too short to be scrolled.
 */

import { View, Text, ActivityIndicator, StyleSheet } from 'react-native'

import { useTheme, space } from '../theme'
import { Button } from './ui'

export default function LoadMoreFooter({ loading, error, hasMore, onLoadMore, loaded, total, children }) {
  const { colors } = useTheme()

  if (loading) {
    return <ActivityIndicator style={styles.spinner} size="small" color={colors.primary} accessibilityLabel="Loading more" />
  }
  if (error) {
    return (
      <View style={styles.box}>
        <Text style={[styles.text, { color: colors.danger }]}>{error}</Text>
        <Button title="Try again" size="sm" variant="soft" onPress={onLoadMore} />
      </View>
    )
  }
  if (!hasMore) return children ?? null
  return (
    <View style={styles.box}>
      {typeof loaded === 'number' && typeof total === 'number' ? (
        <Text style={[styles.text, { color: colors.textTertiary }]}>{loaded} of {total} loaded</Text>
      ) : null}
      <Button title="Load more" size="sm" variant="soft" onPress={onLoadMore} />
    </View>
  )
}

const styles = StyleSheet.create({
  spinner: { paddingVertical: space.lg },
  box: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  text: { fontSize: 12.5, textAlign: 'center' },
})
