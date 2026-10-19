// Control characters other than line feed and tab, the C1 controls, line and paragraph separators, byte-order
// marks, and invisible zero-width and direction characters. The joiner and non-joiner (U+200D, U+200C) stay:
// they carry meaning inside emoji and some scripts (plan decision 6).
// Written with escapes so no invisible character sits in the source: U+061C, U+200B, U+200E, U+200F, U+2028,
// U+2029, U+202A-202E, U+2060, U+2066-2069, U+FEFF.
export const DISALLOWED =
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/
