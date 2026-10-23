/**
 * Icons, drawn as SVG paths on a 24 × 24 grid.
 *
 * One component, `<Icon name="…" />`, so a screen never imports a glyph set and the whole
 * set can be swapped for the designer's own exports by editing this file alone. Stroke icons
 * take `color` and `size`; `filled` draws the solid variant where there is one (the tab bar
 * fills the icon of the tab you are on).
 */

import Svg, { Path, Circle, Rect, G } from 'react-native-svg'

const STROKE = 1.8

/** A five-point star with soft corners, the Influencers tab's mark. */
const STAR = 'M12 2.8l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.1 6.8 18.85l1-5.8-4.2-4.1 5.8-.85z'

const SHAPES = {
  home: ({ color, filled }) => (
    <Path
      d="M3.5 10.8 12 3.6l8.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.4H9.2v5.4H5A1.5 1.5 0 0 1 3.5 19z"
      fill={filled ? color : 'none'} stroke={color} strokeWidth={STROKE} strokeLinejoin="round"
    />
  ),
  // The Influencers tab: a rounded star with a face.
  star: ({ color, filled }) => (
    <G>
      <Path d={STAR} fill={filled ? color : 'none'} stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
      <Circle cx="9.6" cy="11.4" r="1" fill={filled ? '#080353' : color} />
      <Circle cx="14.4" cy="11.4" r="1" fill={filled ? '#080353' : color} />
      <Path d="M10 14.1c.6.5 1.3.7 2 .7s1.4-.2 2-.7" fill="none" stroke={filled ? '#080353' : color} strokeWidth="1.2" strokeLinecap="round" />
    </G>
  ),
  // The Queue tab: a bar above two lines.
  queue: ({ color, filled }) => (
    <G>
      <Rect x="3.2" y="4" width="17.6" height="6.4" rx="2.2" fill={filled ? color : 'none'} stroke={color} strokeWidth={STROKE} />
      <Path d="M3.5 14.6h17M3.5 19h17" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </G>
  ),
  // The Settings tab: a hexagon with a hub.
  settings: ({ color, filled }) => (
    <G>
      <Path
        d="M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3z"
        fill={filled ? color : 'none'} stroke={color} strokeWidth={STROKE} strokeLinejoin="round"
      />
      <Circle cx="12" cy="12" r="3" fill={filled ? '#080353' : 'none'} stroke={filled ? '#080353' : color} strokeWidth={STROKE} />
    </G>
  ),
  back: ({ color }) => (
    <Path d="M19 12H5.2M11 5.8 4.8 12l6.2 6.2" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  ),
  chevron: ({ color }) => (
    <Path d="m9 5.5 6.5 6.5L9 18.5" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  ),
  close: ({ color }) => (
    <Path d="M6 6l12 12M18 6 6 18" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
  ),
  check: ({ color }) => (
    <Path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
  ),
  // The four-point sparkle: Create, suggestions, credits.
  sparkle: ({ color, filled }) => (
    <Path
      d="M12 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5zM19 15.5c.2 1.8 1.2 2.8 3 3-1.8.2-2.8 1.2-3 3-.2-1.8-1.2-2.8-3-3 1.8-.2 2.8-1.2 3-3z"
      fill={filled === false ? 'none' : color} stroke={color} strokeWidth={filled === false ? 1.4 : 0} strokeLinejoin="round"
    />
  ),
  play: ({ color }) => <Path d="M8 5.5v13l11-6.5z" fill={color} />,
  // A rounded screen with a play triangle: product videos.
  video: ({ color }) => (
    <G>
      <Rect x="3.5" y="5" width="17" height="14" rx="3.2" fill="none" stroke={color} strokeWidth={STROKE} />
      <Path d="M10.2 9.2v5.6l4.6-2.8z" fill={color} />
    </G>
  ),
  // A figure mid-stride: motion copy.
  motion: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="13.4" cy="4.8" r="1.9" />
      <Path d="m10.8 20 2-5.2-2.6-2.4 1-4.4 3.4 1.6 2.4 2.2M8.2 11.4l2-2.4M13 14.8l3 1.4 1 3.8" />
    </G>
  ),
  // A framed picture with a sun and a hill: images.
  image: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3.5" y="4.5" width="17" height="15" rx="3.2" />
      <Circle cx="9" cy="10" r="1.6" />
      <Path d="m4.5 17.2 4.7-4.5 3.3 3.1 2.7-2.5 4.3 3.5" />
    </G>
  ),
  // A clock face: something that lasts.
  clock: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M12 7.6V12l3 2" />
    </G>
  ),
  // An arrow turning back on itself: given back.
  refresh: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4" />
      <Path d="M19.8 4.6v4.2h-4.2" />
    </G>
  ),
  // A bank card: one payment.
  card: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="5.5" width="18" height="13" rx="3" />
      <Path d="M3 10h18M7 15h3.2" />
    </G>
  ),
  // An eye, open: the password is hidden, tap to show it. With a slash: it is shown, tap to hide it.
  eye: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z" />
      <Circle cx="12" cy="12" r="2.9" />
    </G>
  ),
  eyeOff: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z" />
      <Circle cx="12" cy="12" r="2.9" />
      <Path d="M4.6 4.6l14.8 14.8" />
    </G>
  ),
  // A triangle with a mark: something to read before going on.
  warning: ({ color }) => (
    <G fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3.8 21.2 19.6H2.8z" />
      <Path d="M12 10v4.2" />
      <Circle cx="12" cy="16.9" r="0.6" fill={color} />
    </G>
  ),
  plus: ({ color }) => <Path d="M12 5v14M5 12h14" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />,
  share: ({ color }) => (
    <Path d="M12 15V3.8M7.6 8 12 3.6 16.4 8M5 12.5v6.2c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6v-6.2" fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
  ),
  // Two corners pulling outward: "open this bigger".
  expand: ({ color }) => (
    <Path d="M14.5 4H20v5.5M20 4l-6.5 6.5M9.5 20H4v-5.5M4 20l6.5-6.5" fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
  ),
}

/**
 * @param {{name: keyof typeof SHAPES, size?: number, color?: string, filled?: boolean}} props
 */
export default function Icon({ name, size = 24, color = '#000000', filled = false }) {
  const Shape = SHAPES[name]
  if (!Shape) return null
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <Shape color={color} filled={filled} />
    </Svg>
  )
}
