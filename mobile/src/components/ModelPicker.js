/**
 * Model picker.
 *
 * The default model is always first and marked as such; the rest are
 * alternatives that support the same feature, so they can be tried and
 * compared without touching code.
 */

import { useState } from 'react'
import { View, Text, Pressable, StyleSheet, LayoutAnimation } from 'react-native'

import { useTheme, space, radius, font, layout } from '../theme'
import Icon from './icons'

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
            borderColor: open ? colors.primary : colors.glassEdge,
            backgroundColor: colors.field,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <View style={styles.flex}>
          <Text style={[styles.currentLabel, font('medium'), { color: colors.textPrimary }]} numberOfLines={1}>
            {current.label}
            {current.id === defaultId ? (
              <Text style={[font('regular'), { color: colors.textTertiary }]}>  · default</Text>
            ) : null}
          </Text>
          {current.note ? (
            <Text style={[styles.currentNote, { color: colors.textTertiary }]} numberOfLines={1}>
              {current.note}
            </Text>
          ) : null}
        </View>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chevron" size={18} color={colors.textSecondary} />
        </View>
      </Pressable>

      {open ? (
        <View style={styles.list}>
          {models.map(m => {
            const active = m.id === current.id
            return (
              <Pressable
                key={m.id}
                onPress={() => { onChange(m.id); toggle() }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: active ? colors.accentSoft : colors.surface, borderColor: active ? colors.primary : 'transparent' },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <View style={styles.flex}>
                  <Text style={[styles.optionLabel, font('medium'), { color: active ? colors.primary : colors.textPrimary }]}>
                    {m.label}
                    {m.id === defaultId ? (
                      <Text style={[font('regular'), { color: colors.textTertiary }]}>  · default</Text>
                    ) : null}
                  </Text>
                  {m.note ? (
                    <Text style={[styles.optionNote, { color: colors.textSecondary }]}>{m.note}</Text>
                  ) : null}
                </View>
                {active ? <Icon name="check" size={18} color={colors.primary} /> : null}
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
    borderWidth: 1, borderRadius: radius.pill,
    paddingHorizontal: space.xl - 2, paddingVertical: space.sm, minHeight: layout.controlHeight + 4,
  },
  currentLabel: { fontSize: 15 },
  currentNote: { fontSize: 12, marginTop: 2 },

  list: { gap: space.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  optionLabel: { fontSize: 14.5 },
  optionNote: { fontSize: 12, marginTop: 2, lineHeight: 16 },
})
