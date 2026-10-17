import { useSyncExternalStore } from 'react'

// Plain-module store (editStore style) for surface/selection/zoom view state.
// The keyboard router in App.jsx is the only writer for most of these.

export const THUMB_STOPS = [112, 176, 240, 320]

// theme is applied to <html data-theme> at module load so first paint is right;
// dark is the native default, light is opt-in (persisted)
const initialTheme = (() => {
  try { return localStorage.getItem('albedo.theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' }
})()
if (typeof document !== 'undefined') document.documentElement.dataset.theme = initialTheme

let state = {
  surface: 'library', // 'library' | 'develop' | 'compose'
  mode: 'grid', // 'grid' | 'compare' | 'survey' | 'cull' — Library sub-view
  selectedId: null,
  selection: new Set(),
  thumbSize: THUMB_STOPS[1],
  gridCols: 1, // written by Grid so the router can do 2D arrow nav
  zoom: 'fit', // 'fit' | 1 | 2 — develop loupe
  panX: 0.5, // loupe view center in developed-output-normalized coords
  panY: 0.5,
  cropMode: false, // develop crop/straighten overlay active
  cropGrid: 'thirds', // 'thirds' | 'golden' | 'off'
  navCollapsed: (() => {
    try { return localStorage.getItem('albedo.nav') === '0' } catch { return false }
  })(), // library navigator folded to its 4px rib
  navEdit: null, // { kind: 'album'|'smart', id } — row in inline-rename mode
  theme: initialTheme, // 'dark' | 'light' — mirrors html[data-theme]
  lightsOut: 0, // 0 normal · 1 chrome dimmed · 2 chrome black (L cycles, Esc exits)
  infoOverlay: (() => { // 0 off · 1 name+dims · 2 +EXIF — on-image card, per session
    try { return Math.min(2, Math.max(0, +sessionStorage.getItem('albedo.info') || 0)) } catch { return 0 }
  })(),
}
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useViewState = () => useSyncExternalStore(subscribe, () => state)
export const getViewState = () => state

export function setSurface(surface) {
  if (surface === state.surface) return
  state = { ...state, surface }
  emit()
}

// Library view mode: compare (C) / survey (N) / cull (⇧C); G resets to grid.
export function setMode(mode) {
  if (mode === state.mode) return
  state = { ...state, mode }
  emit()
}

export function select(id) {
  // photo focus change resets the loupe and closes crop mode
  state = {
    ...state, selectedId: id, selection: new Set(id != null ? [id] : []),
    zoom: 'fit', cropMode: false,
  }
  emit()
}

export function setZoom(zoom, panX = state.panX, panY = state.panY) {
  state = { ...state, zoom, panX, panY }
  emit()
}

export const toggleZoom = () => setZoom(state.zoom === 'fit' ? 1 : 'fit')

export function nudgePan(dx, dy) {
  state = {
    ...state,
    panX: Math.max(0, Math.min(1, state.panX + dx)),
    panY: Math.max(0, Math.min(1, state.panY + dy)),
  }
  emit()
}

export function setCropMode(cropMode) {
  if (cropMode === state.cropMode) return
  state = { ...state, cropMode, zoom: 'fit' } // crop mode always works at fit
  emit()
}

const GRIDS = ['thirds', 'golden', 'off']
export function cycleCropGrid() {
  state = { ...state, cropGrid: GRIDS[(GRIDS.indexOf(state.cropGrid) + 1) % GRIDS.length] }
  emit()
}

export function toggleSelect(id) {
  const selection = new Set(state.selection)
  if (selection.has(id) && selection.size > 1) selection.delete(id)
  else selection.add(id)
  state = { ...state, selectedId: id, selection }
  emit()
}

export function setSelection(ids, focusId) {
  state = { ...state, selectedId: focusId ?? state.selectedId, selection: new Set(ids) }
  emit()
}

export function bumpThumb(dir) {
  const at = THUMB_STOPS.indexOf(state.thumbSize)
  const to = Math.min(THUMB_STOPS.length - 1, Math.max(0, at + dir))
  if (to === at) return
  state = { ...state, thumbSize: THUMB_STOPS[to] }
  emit()
}

export function toggleNav() {
  const navCollapsed = !state.navCollapsed
  try { localStorage.setItem('albedo.nav', navCollapsed ? '0' : '1') } catch { /* private mode */ }
  state = { ...state, navCollapsed }
  emit()
}

export function setNavEdit(navEdit) {
  state = { ...state, navEdit }
  emit()
}

export function toggleTheme() {
  const theme = state.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem('albedo.theme', theme) } catch { /* private mode */ }
  state = { ...state, theme }
  emit()
}

export function cycleLightsOut() {
  setLightsOut((state.lightsOut + 1) % 3)
}

export function setLightsOut(lightsOut) {
  if (lightsOut === state.lightsOut) return
  state = { ...state, lightsOut }
  emit()
}

export function cycleInfoOverlay() {
  const infoOverlay = (state.infoOverlay + 1) % 3
  try { sessionStorage.setItem('albedo.info', String(infoOverlay)) } catch { /* private mode */ }
  state = { ...state, infoOverlay }
  emit()
}

export function setGridCols(gridCols) {
  if (gridCols === state.gridCols) return
  state = { ...state, gridCols }
  emit()
}
