/**
 * Model picker.
 *
 * The default model is always first and marked as such; the rest are
 * alternatives that support the same feature, so they can be tried and
 * compared without touching code.
 */

import { useState } from 'react'
import { View, Text, Pressable, StyleSheet, LayoutAnimation } from 'react-native'

import { useTheme, space, radius } from '../theme'

export default function ModelPicker({ models, value, onChange, defaultId }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)

  const current = models.find(m => m.id === value) || models[0]

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setOpen(o => !o)
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [
          styles.trigger,
          {
            borderColor: open ? colors.brand : colors.border,
            backgroundColor: colors.bg,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <View style={styles.flex}>
          <Text style={[styles.currentLabel, { color: colors.textPrimary }]} numberOfLines={1}>
            {current.label}
            {current.id === defaultId ? (
              <Text style={{ color: colors.textTertiary }}>  · default</Text>
            ) : null}
          </Text>
          {current.note ? (
            <Text style={[styles.currentNote, { color: colors.textTertiary }]} numberOfLines={1}>
              {current.note}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.caret, { color: colors.textTertiary }]}>{open ? '⌄' : '›'}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.list, { borderColor: colors.borderSubtle, backgroundColor: colors.surface }]}>
          {models.map((m, i) => {
            const active = m.id === current.id
            return (
              <Pressable
                key={m.id}
                onPress={() => { onChange(m.id); toggle() }}
                android_ripple={{ color: colors.borderSubtle }}
                style={[
                  styles.option,
                  i < models.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.borderSubtle,
                  },
                  active && { backgroundColor: colors.brandSoft },
                ]}
              >
                <View style={styles.flex}>
                  <Text style={[styles.optionLabel, { color: active ? colors.brand : colors.textPrimary }]}>
                    {m.label}
                    {m.id === defaultId ? (
                      <Text style={{ color: colors.textTertiary, fontWeight: '400' }}>  · default</Text>
                    ) : null}
                  </Text>
                  {m.note ? (
                    <Text style={[styles.optionNote, { color: colors.textSecondary }]}>{m.note}</Text>
                  ) : null}
                </View>
                {active ? <Text style={{ color: colors.brand, fontSize: 15 }}>✓</Text> : null}
              </Pressable>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  flex: { flex: 1 },
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderWidth: 1.5, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 52,
  },
  currentLabel: { fontSize: 15, fontWeight: '600' },
  currentNote: { fontSize: 12, marginTop: 2 },
  caret: { fontSize: 18, lineHeight: 20 },

  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  optionLabel: { fontSize: 14.5, fontWeight: '600' },
  optionNote: { fontSize: 12, marginTop: 2, lineHeight: 16 },
})
