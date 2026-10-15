// The --ui-scale dial (tokens.css) as a number, for the few layouts that do
// their own geometry in JS and must agree with the scaled CSS boxes.
export function uiScale() {
  if (typeof document === 'undefined') return 1
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))
  return v > 0 ? v : 1
}
