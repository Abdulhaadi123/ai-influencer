/*
 * Icons: a few 24×24 outline glyphs, drawn as SVG by script (no icon font, no
 * external file, nothing for the page's policy to object to).
 *
 * Each entry is a list of [element, attributes] pairs.
 */

import { svg } from './dom.js'

const path = d => ['path', { d }]
const line = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }]
const circle = (cx, cy, r) => ['circle', { cx, cy, r }]
const rect = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }]
const poly = points => ['polyline', { points }]

export const ICONS = Object.freeze({
  overview: [rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(14, 14, 7, 7, 1), rect(3, 14, 7, 7, 1)],
  users: [path('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), circle(9, 7, 4), path('M23 21v-2a4 4 0 0 0-3-3.87'), path('M16 3.13a4 4 0 0 1 0 7.75')],
  jobs: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]],
  moderation: [path('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')],
  prices: [path('M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z'), line(7, 7, 7.01, 7)],
  audit: [circle(12, 12, 10), poly('12 6 12 12 16 14')],
  settings: [line(4, 21, 4, 14), line(4, 10, 4, 3), line(12, 21, 12, 12), line(12, 8, 12, 3), line(20, 21, 20, 16), line(20, 12, 20, 3), line(1, 14, 7, 14), line(9, 8, 15, 8), line(17, 16, 23, 16)],
  search: [circle(11, 11, 7), line(21, 21, 16.65, 16.65)],
  x: [line(18, 6, 6, 18), line(6, 6, 18, 18)],
  check: [poly('20 6 9 17 4 12')],
  'chevron-left': [poly('15 18 9 12 15 6')],
  'chevron-right': [poly('9 18 15 12 9 6')],
  'chevron-down': [poly('6 9 12 15 18 9')],
  'arrow-up': [line(12, 19, 12, 5), poly('5 12 12 5 19 12')],
  'arrow-down': [line(12, 5, 12, 19), poly('19 12 12 19 5 12')],
  menu: [line(3, 12, 21, 12), line(3, 6, 21, 6), line(3, 18, 21, 18)],
  refresh: [path('M21 12a9 9 0 1 1-3-6.7'), poly('21 3 21 9 15 9')],
  more: [circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)],
  'log-out': [path('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), poly('16 17 21 12 16 7'), line(21, 12, 9, 12)],
  // The app icon's chevron: the Influenza mark.
  brand: [poly('5 19 12 5 19 19')],
  copy: [rect(9, 9, 13, 13, 2), path('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  trash: [poly('3 6 5 6 21 6'), path('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'), path('M10 11v6'), path('M14 11v6'), path('M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2')],
  'user-x': [path('M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), circle(8.5, 7, 4), line(18, 8, 23, 13), line(23, 8, 18, 13)],
  'user-check': [path('M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), circle(8.5, 7, 4), poly('17 11 19 13 23 9')],
  shield: [path('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')],
  lock: [rect(3, 11, 18, 11, 2), path('M7 11V7a5 5 0 0 1 10 0v4')],
  image: [rect(3, 3, 18, 18, 2), circle(8.5, 8.5, 1.5), poly('21 15 16 10 5 21')],
  video: [['polygon', { points: '23 7 16 12 23 17 23 7' }], rect(1, 5, 15, 14, 2)],
  flag: [path('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'), line(4, 22, 4, 15)],
  info: [circle(12, 12, 10), line(12, 16, 12, 12), line(12, 8, 12.01, 8)],
  alert: [path('M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'), line(12, 9, 12, 13), line(12, 17, 12.01, 17)],
  eye: [path('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'), circle(12, 12, 3)],
  'eye-off': [path('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'), line(1, 1, 23, 23)],
  plus: [line(12, 5, 12, 19), line(5, 12, 19, 12)],
  edit: [path('M12 20h9'), path('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z')],
  coins: [circle(8, 8, 6), path('M18.09 10.37A6 6 0 1 1 10.34 18'), path('M7 6h1v4'), path('M16.71 13.88l.7.71-2.82 2.82')],
  clock: [circle(12, 12, 10), poly('12 6 12 12 16 14')],
  'external': [path('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'), poly('15 3 21 3 21 9'), line(10, 14, 21, 3)],
})

/**
 * @param {keyof typeof ICONS | string} name
 * @param {{size?: number, class?: string}} [opts]
 * @returns {SVGElement}  decorative (aria-hidden); put the meaning in text next to it
 */
export function icon(name, { size = 18, class: className = '' } = {}) {
  const parts = ICONS[name] || ICONS.info
  return svg('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false', class: `icon ${className}`.trim(),
  }, parts.map(([tag, attrs]) => svg(tag, attrs)))
}
