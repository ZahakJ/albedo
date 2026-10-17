import { setHealMode } from '../ui/HealOverlay.jsx'
import {
  getViewState, setSurface, setMode, bumpThumb, setCropMode, toggleZoom, setZoom,
  toggleTheme, cycleLightsOut, cycleInfoOverlay,
} from './viewStore.js'
import { getCatalogState, setMeta, setFilter, albumAdd } from './catalogStore.js'
import { getState as getEditState, undo, redo, applyModules, commitParam, resetAll } from './editStore.js'
import { getParam, hasEdits } from '../engine/editdoc.js'
import { toast } from './toastStore.js'
import { getClipboard, allPresets, applyPresetToPhotos } from './presetStore.js'
import { toggleBefore, toggleClipOverlay } from '../ui/devFlags.js'
import { getVersionState, createVersion, switchVersion, versionLabel } from './versionStore.js'
import { toggleMaskMode, getMaskUi, setTool, addBrushMask } from '../ui/MaskPanel.jsx'
import { getCompose, saveDocument, closeDocument, undo as coUndo, redo as coRedo, op as coOp } from './composeClient.js'
import { editInCompose } from '../compose/ui/smartEdit.js'

// ONE registry feeds both the ⌘K palette and the '?' cheat-sheet.
// Row: { id, title, keywords?, shortcut?, category, when?, run?,
//        noPalette? (sheet-only row), noSheet? (palette-only row) }.
// Sheet rule: shortcut && !noSheet. Palette rule: !noPalette && when().

// App owns the pieces commands can't reach from stores (file input, overlays).
const host = {
  openFiles() {}, openFor() {}, openOverlay() {}, paste() {},
  focusSearch() {}, requestDelete() {}, clearRejects() {}, newAlbum() {}, saveSmart() {},
}
export function setCommandHost(h) { Object.assign(host, h) }
// panels outside App (Develop's Export button) route overlays through here too
export const openOverlay = (name) => host.openOverlay(name)

const selIds = () => {
  const v = getViewState()
  return v.selection.size ? [...v.selection] : v.selectedId != null ? [v.selectedId] : []
}
const inDev = () => getViewState().surface === 'develop'
const inCompose = () => getViewState().surface === 'compose'
const hasComposeDoc = () => !!getCompose().doc
const hasSel = () => selIds().length > 0
const hasDoc = () => !!getEditState().doc
const cull = (patch) => () => { for (const id of selIds()) setMeta(id, patch) }
const flagFilter = (value) => () => {
  const f = getCatalogState().filter
  setFilter({ flag: f.flag === value ? null : value })
}
const starFilter = (n) => () => {
  const f = getCatalogState().filter
  setFilter({ minRating: f.minRating === n ? null : n })
}
// panel sections own their open state (localStorage per id) — the header
// button is the single toggle path, so commands click it
const clickSec = (id) => () => document.querySelector(`.sec[data-sec=${id}] .sec-head`)?.click()

// sheet order — sized so the 3-column cheat card fills evenly
export const CATEGORIES = [
  ['navigate', 'Navigate'],
  ['cull', 'Cull'],
  ['develop', 'Develop'],
  ['workflow', 'Workflow'],
  ['filter', 'Filter'],
  ['compose', 'Compose'],
]

const LABELS = [['red', '6'], ['yellow', '7'], ['green', '8'], ['blue', '9']]
const SECTIONS = [['tone', 'Tone'], ['wb', 'WB'], ['curve', 'Curve'],
  ['color', 'Color'], ['mixer', 'Mixer'], ['effects', 'Effects']]

export const registry = [
  // ── navigate ──
  { id: 'go-library', title: 'Go to Library', keywords: 'grid photos back', shortcut: 'G',
    category: 'navigate', when: inDev, run: () => setSurface('library') },
  { id: 'go-develop', title: 'Open in Develop', keywords: 'edit photo', shortcut: 'D',
    category: 'navigate', when: hasSel,
    run: () => {
      const p = getCatalogState().photos.find((q) => q.id === getViewState().selectedId)
      if (p) host.openFor(p)
    } },
  { id: 'open-files', title: 'Open Files…', keywords: 'import add load', shortcut: 'O',
    category: 'navigate', run: () => host.openFiles() },
  { id: 'go-compose', title: 'Go to Compose', keywords: 'layers editor photoshop composite retouch',
    shortcut: 'E', category: 'navigate', when: () => !inCompose(),
    run: () => setSurface('compose') },
  { id: 'edit-in-compose', title: 'Edit in Compose', keywords: 'layers smart object photoshop composite',
    shortcut: '⌘⇧E', category: 'develop', when: () => inDev() && hasDoc(),
    run: () => editInCompose().catch(() => {}) },
  { id: 'compose-save', title: 'Save Compose Document', keywords: 'compose persist project', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(),
    run: () => saveDocument().catch(() => {}) },
  { id: 'compose-close', title: 'Close Compose Document', keywords: 'compose recent documents', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(),
    run: () => closeDocument().catch(() => {}) },
  { id: 'compose-undo', title: 'Undo (Compose)', keywords: 'compose history back', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(), run: () => coUndo() },
  { id: 'compose-redo', title: 'Redo (Compose)', keywords: 'compose history forward', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(), run: () => coRedo() },
  { id: 'compose-flatten', title: 'Flatten Image', keywords: 'compose merge all layers', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(), run: () => coOp('flatten') },
  { id: 'compose-stamp', title: 'Stamp Visible', keywords: 'compose merge copy layer', noSheet: true,
    category: 'workflow', when: () => inCompose() && hasComposeDoc(), run: () => coOp('stampVisible') },
  // ── compose (sheet only: the keys belong to the Compose surface; the
  // manual has them all) ──
  { id: 'co-move', title: 'Move · Marquee · Lasso', shortcut: 'V M L', category: 'compose', noPalette: true },
  { id: 'co-wand', title: 'Wand · AI Select', shortcut: 'W ⇧W', category: 'compose', noPalette: true },
  { id: 'co-paint', title: 'Brush · Eraser · Smudge', shortcut: 'B E R', category: 'compose', noPalette: true },
  { id: 'co-retouch', title: 'Clone · Heal · Dodge', shortcut: 'S J O', category: 'compose', noPalette: true },
  { id: 'co-type', title: 'Gradient · Type · Shape', shortcut: 'G T U', category: 'compose', noPalette: true },
  { id: 'co-more', title: 'Liquify · Crop · Pick Colour', shortcut: 'Q C I', category: 'compose', noPalette: true },
  { id: 'co-size', title: 'Brush Size', shortcut: '[ ]', category: 'compose', noPalette: true },
  { id: 'co-xf', title: 'Free Transform', shortcut: '⌘T', category: 'compose', noPalette: true },
  { id: 'co-mask', title: 'Paint on Mask', shortcut: '\\', category: 'compose', noPalette: true },
  { id: 'nav-photos', title: 'Previous / Next Photo', shortcut: '← →', category: 'navigate', noPalette: true },
  { id: 'thumb-up', title: 'Bigger Thumbnails', keywords: 'zoom grid size', shortcut: '+',
    category: 'navigate', run: () => bumpThumb(1) },
  { id: 'thumb-down', title: 'Smaller Thumbnails', keywords: 'zoom grid size', shortcut: '−',
    category: 'navigate', run: () => bumpThumb(-1) },
  { id: 'view-compare', title: 'Compare View', keywords: 'two-up select candidate versus',
    shortcut: 'C', category: 'navigate',
    when: () => !inDev() && getCatalogState().photos.length >= 2,
    run: () => setMode('compare') },
  { id: 'view-survey', title: 'Survey View', keywords: 'tiles n-up spread contact sheet',
    shortcut: 'N', category: 'navigate',
    when: () => !inDev() && hasSel(),
    run: () => setMode('survey') },
  { id: 'view-cull', title: 'Cull Mode', keywords: 'fullscreen pass rate flag sweep',
    shortcut: '⇧C', category: 'navigate',
    when: () => !inDev() && hasSel(),
    run: () => setMode('cull') },

  // ── cull ──
  { id: 'pick', title: 'Pick', keywords: 'flag keep', shortcut: 'P',
    category: 'cull', when: hasSel, run: cull({ flag: 1 }) },
  { id: 'reject', title: 'Reject', keywords: 'flag cull x', shortcut: 'X',
    category: 'cull', when: hasSel, run: cull({ flag: -1 }) },
  { id: 'unflag', title: 'Unflag', keywords: 'clear flag', shortcut: 'U',
    category: 'cull', when: hasSel, run: cull({ flag: 0 }) },
  { id: 'delete-photos', title: 'Delete Photos…', keywords: 'remove trash erase',
    shortcut: '⌫', category: 'cull', when: () => !inDev() && hasSel(),
    run: () => host.requestDelete() },
  { id: 'clear-rejects', title: 'Clear Rejects…', keywords: 'sweep delete rejected x-flagged',
    category: 'cull', when: () => (getCatalogState().sidebar?.rejected ?? 0) > 0,
    run: () => host.clearRejects() },
  { id: 'rate-sheet', title: 'Rate', shortcut: '0–5', category: 'cull', noPalette: true },
  { id: 'label-sheet', title: 'Color Label', shortcut: '6–9', category: 'cull', noPalette: true },
  ...[0, 1, 2, 3, 4, 5].map((n) => ({
    id: `rate-${n}`, title: n ? `Rate ${'★'.repeat(n)}` : 'Clear Rating',
    keywords: `rating stars ${n}`, shortcut: String(n),
    category: 'cull', noSheet: true, when: hasSel, run: cull({ rating: n }),
  })),
  ...LABELS.map(([c, key]) => ({
    id: `label-${c}`, title: `Label ${c[0].toUpperCase()}${c.slice(1)}`,
    keywords: 'color label tag', shortcut: key,
    category: 'cull', noSheet: true, when: hasSel,
    run: () => {
      for (const id of selIds()) {
        const p = getCatalogState().photos.find((q) => q.id === id)
        setMeta(id, { colorLabel: p?.colorLabel === c ? null : c })
      }
    },
  })),

  // ── filter ──
  { id: 'filter-picks', title: 'Filter: Picks', keywords: 'flagged show', category: 'filter', run: flagFilter(1) },
  { id: 'filter-rejects', title: 'Filter: Rejects', keywords: 'rejected show', category: 'filter', run: flagFilter(-1) },
  { id: 'filter-unflagged', title: 'Filter: Unflagged', keywords: 'show', category: 'filter', run: flagFilter(0) },
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: `filter-stars-${n}`, title: `Filter: ★ ≥ ${n}`, keywords: 'stars rating minimum',
    category: 'filter', noSheet: true, run: starFilter(n),
  })),
  { id: 'filter-clear', title: 'Clear Filters', keywords: 'reset show all', shortcut: '⌥\\',
    category: 'filter',
    run: () => setFilter({ flag: null, minRating: null, colorLabel: null, search: null }) },
  { id: 'search', title: 'Search Photos', keywords: 'find filename camera lens query',
    shortcut: '⌘F', category: 'filter', when: () => !inDev(), run: () => host.focusSearch() },
  { id: 'save-smart', title: 'Save Filter as Smart Collection',
    keywords: 'smart saved search collection',
    category: 'filter', noSheet: true,
    when: () => {
      const f = getCatalogState().filter
      return f.flag != null || (f.minRating ?? 0) > 0 || f.colorLabel != null || !!f.search
    },
    run: () => host.saveSmart() },
  { id: 'new-album', title: 'New Album', keywords: 'collection create group',
    category: 'workflow', noSheet: true, when: () => !inDev(), run: () => host.newAlbum() },

  // ── develop ──
  { id: 'undo', title: 'Undo', shortcut: '⌘Z', category: 'develop', when: hasDoc, run: undo },
  { id: 'redo', title: 'Redo', shortcut: '⇧⌘Z', category: 'develop', when: hasDoc, run: redo },
  { id: 'before', title: 'Before / After', keywords: 'original compare toggle', shortcut: '\\',
    category: 'develop', when: inDev, run: toggleBefore },
  { id: 'clip', title: 'Clip Overlay', keywords: 'clipping highlights shadows warning', shortcut: 'J',
    category: 'develop', when: inDev, run: toggleClipOverlay },
  { id: 'reset-all', title: 'Reset to Original', keywords: 'revert discard undo all original',
    shortcut: '⇧⌘R', category: 'develop',
    when: () => inDev() && hasDoc() && hasEdits(getEditState().doc),
    run: () => { resetAll(); toast('Reset to original — ⌘Z to undo') } },
  { id: 'bw', title: 'Black & White', keywords: 'monochrome grayscale bw toggle', shortcut: 'V',
    category: 'develop', when: () => inDev() && hasDoc(),
    run: () => {
      const doc = getEditState().doc
      commitParam('bw', 'on', getParam(doc, 'bw', 'on') ? 0 : 1)
    } },
  { id: 'crop', title: 'Crop & Straighten', keywords: 'geometry rotate angle aspect', shortcut: 'R',
    category: 'develop', when: () => inDev() && hasDoc(), run: () => setCropMode(true) },
  { id: 'remove', title: 'Remove', keywords: 'erase content aware inpaint object distraction', shortcut: 'Q',
    category: 'develop', when: () => inDev() && hasDoc(), run: () => setHealMode(true, 'remove') },
  { id: 'heal', title: 'Heal & Clone', keywords: 'spot dust retouch', shortcut: 'H',
    category: 'develop', when: () => inDev() && hasDoc(), run: () => setHealMode(true, 'heal') },
  { id: 'mask-mode', title: 'Masking', keywords: 'local adjustment mask gradient', shortcut: 'M',
    category: 'develop', when: () => inDev() && hasDoc(), run: toggleMaskMode },
  { id: 'mask-linear', title: 'New Linear Mask', keywords: 'gradient graduated mask', shortcut: 'L',
    category: 'develop', noSheet: true, when: () => inDev() && hasDoc(),
    run: () => { if (!getMaskUi().on) toggleMaskMode(); setTool('linear') } },
  { id: 'mask-radial', title: 'New Radial Mask', keywords: 'ellipse circle mask', shortcut: '⇧M',
    category: 'develop', noSheet: true, when: () => inDev() && hasDoc(),
    run: () => { if (!getMaskUi().on) toggleMaskMode(); setTool('radial') } },
  { id: 'mask-brush', title: 'New Brush Mask', keywords: 'paint stroke mask', shortcut: 'K',
    category: 'develop', noSheet: true, when: () => inDev() && hasDoc(),
    run: () => { if (!getMaskUi().on) toggleMaskMode(); addBrushMask() } },
  { id: 'mask-tools', title: 'Mask Tools (mask mode)', shortcut: 'L ⇧M K', category: 'develop', noPalette: true },
  { id: 'mask-wash', title: 'Mask Overlay (mask mode)', shortcut: 'O', category: 'develop', noPalette: true },
  { id: 'zoom-toggle', title: 'Zoom 100% / Fit', keywords: 'loupe pixels 1:1', shortcut: 'Z',
    category: 'develop', when: () => inDev() && hasDoc(), run: () => toggleZoom() },
  { id: 'zoom-200', title: 'Zoom 200%', keywords: 'loupe pixels', category: 'develop',
    noSheet: true, when: () => inDev() && hasDoc(), run: () => setZoom(2) },
  { id: 'crop-grid', title: 'Crop Grid (crop mode)', shortcut: 'O', category: 'develop', noPalette: true },
  { id: 'export', title: 'Export…', keywords: 'save render download jpeg png resize',
    shortcut: '⌘E', category: 'develop',
    when: () => (inDev() ? hasDoc() : hasSel()),
    run: () => host.openOverlay('export') },
  { id: 'new-version', title: 'New Version', keywords: 'virtual copy duplicate snapshot',
    category: 'develop', when: () => inDev() && hasDoc(),
    run: () => createVersion() },
  ...SECTIONS.map(([id, label]) => ({
    id: `sec-${id}`, title: `Toggle ${label} Section`, keywords: 'panel collapse expand',
    category: 'develop', when: inDev, run: clickSec(id),
  })),

  // ── workflow ──
  { id: 'copy-settings', title: 'Copy Settings…', keywords: 'clipboard modules edit', shortcut: '⌘C',
    category: 'workflow', when: () => inDev() && hasDoc(), run: () => host.openOverlay('copy') },
  { id: 'paste-settings', title: 'Paste Settings', keywords: 'clipboard apply edit', shortcut: '⌘V',
    category: 'workflow', when: () => !!getClipboard() && (inDev() ? hasDoc() : hasSel()),
    run: () => host.paste() },
  { id: 'theme', title: 'Toggle Light / Dark Theme', keywords: 'appearance daylight darkroom mode',
    category: 'workflow', run: toggleTheme },
  { id: 'lights-out', title: 'Lights Out', keywords: 'dim chrome black focus stage', shortcut: 'L',
    category: 'workflow', run: cycleLightsOut },
  { id: 'info-overlay', title: 'Info Overlay', keywords: 'exif filename dimensions card', shortcut: 'I',
    category: 'develop', when: inDev, run: cycleInfoOverlay },
  { id: 'palette', title: 'Command Palette', shortcut: '⌘K', category: 'workflow',
    noPalette: true, run: () => host.openOverlay('palette') },
  { id: 'cheatsheet', title: 'Keyboard Shortcuts', keywords: 'help keys reference', shortcut: '?',
    category: 'workflow', run: () => host.openOverlay('cheatsheet') },
]

// Palette feed: static rows gated by `when`, plus one apply-command per preset
// and one switch-command per version of the open photo (presets pattern).
export function getAllCommands() {
  const out = registry.filter((c) => !c.noPalette && (!c.when || c.when()))
  if (!inDev() && hasSel()) {
    for (const a of getCatalogState().sidebar?.albums ?? []) {
      out.push({
        id: `album-add:${a.id}`, title: `Add to Album: ${a.name}`,
        keywords: 'album collection add',
        category: 'workflow', run: () => albumAdd(a.id, selIds()),
      })
    }
    for (const p of allPresets()) {
      out.push({
        id: `preset-many:${p.id}`, title: `Apply Preset: ${p.name}`, keywords: 'preset look selection',
        category: 'workflow', run: () => {
          const ids = selIds()
          applyPresetToPhotos(p, ids)
          toast(`${p.name} applied to ${ids.length} photo${ids.length === 1 ? '' : 's'}`)
        },
      })
    }
  }
  if (inDev() && hasDoc()) {
    for (const p of allPresets()) {
      out.push({
        id: `preset:${p.id}`, title: `Preset: ${p.name}`, keywords: 'apply preset',
        category: 'workflow', run: () => applyModules(p.modules),
      })
    }
    const cur = getEditState().doc.versionId ?? 'v_default'
    for (const v of getVersionState().versions) {
      if (v.versionId === cur) continue
      out.push({
        id: `version:${v.versionId}`, title: `Version: ${versionLabel(v)}`,
        keywords: 'switch version virtual copy',
        category: 'develop', run: () => switchVersion(v.versionId),
      })
    }
  }
  return out
}

// Rank: title-start > word-start > fuzzy subsequence (keywords count as words).
export function scoreMatch(q, cmd) {
  const s = q.trim().toLowerCase()
  if (!s) return 1
  const title = cmd.title.toLowerCase()
  const hay = `${title} ${cmd.keywords ?? ''}`
  if (title.startsWith(s)) return 100
  if (hay.split(/[\s:…/]+/).some((w) => w.startsWith(s))) return 60
  let i = 0
  for (const ch of hay) if (ch === s[i] && ++i === s.length) return 20
  return 0
}
