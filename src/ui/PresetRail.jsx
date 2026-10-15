import { useEffect, useState } from 'react'
import {
  usePresets, loadPresets, savePreset, renamePreset, deletePreset,
  GROUPS, nonDefaultGroupIds, pickGroups, BUILTIN_PRESETS,
  importPresetFiles, exportPresets, exportPresetXmp, applyPresetToPhotos,
} from '../state/presetStore.js'
import { useViewState } from '../state/viewStore.js'
import { toast } from '../state/toastStore.js'
import {
  useEditState, previewDoc, cancelPreviewDoc, applyModules, mergeModules,
} from '../state/editStore.js'
import NavigatorBox from './NavigatorBox.jsx'

// Left rail on Develop. Hover = commit-free live preview through the render
// worker; click = apply (one history entry). No amber anywhere: the rail
// borders the canvas mat.

const RAIL_KEY = 'albedo.rail.presets'
const FOLD_KEY = 'albedo.rail.folded' // JSON array of folded group names

// masks are copy/paste-only (geometry-anchored); the rail never offers them
const RAIL_GROUPS = GROUPS.filter((g) => !g.copyOnly)

const Caret = () => (
  <svg className="sec-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M2 0.8l4 3.2-4 3.2z" fill="currentColor" />
  </svg>
)

export default function PresetRail() {
  const { presets } = usePresets()
  const { doc } = useEditState()
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(RAIL_KEY) !== '0' } catch { return true }
  })
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [checked, setChecked] = useState(() => new Set())
  const [menuFor, setMenuFor] = useState(null)
  const [editing, setEditing] = useState(null) // { id, name } | null
  const [folded, setFolded] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')) } catch { return new Set() }
  })
  const { selection } = useViewState()

  useEffect(() => { loadPresets() }, [])

  // outside pointerdown closes the row menu
  useEffect(() => {
    if (menuFor == null) return
    const onDown = (e) => {
      if (e.target instanceof Element && e.target.closest('.preset-menu, .preset-more')) return
      setMenuFor(null)
    }
    addEventListener('pointerdown', onDown, true)
    return () => removeEventListener('pointerdown', onDown, true)
  }, [menuFor])

  const toggleRail = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(RAIL_KEY, next ? '1' : '0') } catch { /* private mode */ }
  }

  const idle = menuFor == null && editing == null // no preview mid-menu/rename

  const beginSave = () => {
    setChecked(new Set(nonDefaultGroupIds(doc).filter((id) => RAIL_GROUPS.some((g) => g.id === id))))
    setName('')
    setSaving(true)
  }
  const commitSave = () => {
    const n = name.trim()
    if (!n || !checked.size) return
    savePreset(n, pickGroups(doc, [...checked]))
    setSaving(false)
  }
  const toggleFold = (g) => setFolded((s) => {
    const n = new Set(s)
    n.has(g) ? n.delete(g) : n.add(g)
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...n])) } catch { /* private mode */ }
    return n
  })
  const onImport = async (files) => {
    if (!files?.length) return
    const r = await importPresetFiles([...files])
    toast(r.message, { timeout: 7000 })
  }
  // on-demand input, like the backup restore: a mounted one would shadow the
  // app's photo input for anything that looks up input[type=file]
  const pickFiles = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.xmp'
    input.multiple = true
    input.onchange = () => onImport(input.files)
    input.click()
  }
  const applyToSelected = (p) => {
    const ids = [...selection]
    applyPresetToPhotos(p, ids)
    toast(`${p.name} applied to ${ids.length} photos`)
  }

  // user presets by group (ungrouped first), then the built-in looks
  const sections = []
  const byGroup = new Map()
  for (const p of presets) {
    const g = p.group ?? ''
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(p)
  }
  for (const g of [...byGroup.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))))
    sections.push({ name: g, items: byGroup.get(g) })
  sections.push({ name: 'Built-in', items: BUILTIN_PRESETS })

  const toggleGroup = (id) => setChecked((s) => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  return (
    <aside className={`preset-rail${open ? '' : ' is-closed'}`}>
      {open && <NavigatorBox />}
      <button type="button" className="rail-head" aria-expanded={open} onClick={toggleRail} data-tip="Presets">
        <Caret />
        <span className="panel-header rail-title">PRESETS</span>
      </button>
      {open && (
        <>
          <ul className="preset-list">
            {!presets.length && <li className="preset-empty">No presets of your own yet</li>}
            {sections.map((sec) => (
              <PresetGroup
                key={sec.name || '·'}
                name={sec.name}
                folded={folded.has(sec.name)}
                onFold={() => toggleFold(sec.name)}
              >
                {sec.items.map((p) => (
                  <li
                    key={p.id}
                    className={`preset-row${p.builtin ? ' is-builtin' : ''}`}
                    onMouseEnter={() => { if (doc && idle) previewDoc(mergeModules(doc, p.modules)) }}
                    onMouseLeave={() => { if (idle) cancelPreviewDoc() }}
                    onClick={() => { if (doc && idle) applyModules(p.modules) }}
                    onContextMenu={(e) => { e.preventDefault(); setMenuFor(p.id) }}
                  >
                    {editing?.id === p.id ? (
                      <input
                        className="preset-edit"
                        autoFocus
                        value={editing.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const n = editing.name.trim()
                            if (n) renamePreset(p.id, n)
                            setEditing(null)
                          } else if (e.key === 'Escape') setEditing(null)
                        }}
                        onBlur={() => setEditing(null)}
                      />
                    ) : (
                      <span className="preset-name">{p.name}</span>
                    )}
                    <button
                      type="button"
                      className="preset-more"
                      title="More"
                      onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id) }}
                    >⋯</button>
                    {menuFor === p.id && (
                      <div className="preset-menu" onClick={(e) => e.stopPropagation()}>
                        {selection.size > 1 && (
                          <button type="button" onClick={() => { setMenuFor(null); applyToSelected(p) }}>
                            Apply to {selection.size} selected
                          </button>
                        )}
                        <button type="button" onClick={() => { setMenuFor(null); exportPresets([p]) }}>Export…</button>
                        <button type="button" onClick={() => { setMenuFor(null); exportPresetXmp(p) }}>Export for Lightroom…</button>
                        {!p.builtin && (
                          <>
                            <button type="button" onClick={() => { setMenuFor(null); setEditing({ id: p.id, name: p.name }) }}>
                              Rename
                            </button>
                            <button
                              type="button"
                              className="menu-danger"
                              onClick={() => { setMenuFor(null); deletePreset(p.id) }}
                            >Delete</button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </PresetGroup>
            ))}
          </ul>
          {saving ? (
            <div className="preset-save">
              <input
                className="preset-edit"
                autoFocus
                placeholder="Preset name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSave()
                  else if (e.key === 'Escape') setSaving(false)
                }}
              />
              <div className="preset-groups">
                {RAIL_GROUPS.map((g) => (
                  <label key={g.id} className="copy-check">
                    <input
                      type="checkbox"
                      checked={checked.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    {g.label}
                  </label>
                ))}
              </div>
              <div className="preset-save-actions">
                <button type="button" className="rail-btn" onClick={() => setSaving(false)}>Cancel</button>
                <button
                  type="button"
                  className="rail-btn"
                  disabled={!name.trim() || !checked.size}
                  onClick={commitSave}
                >Save</button>
              </div>
            </div>
          ) : (
            <div className="preset-foot">
              <button type="button" className="preset-add" onClick={beginSave} disabled={!doc}>
                + Save preset…
              </button>
              <div className="preset-io">
                <button
                  type="button"
                  className="rail-btn"
                  data-tip="Import albedo .json or Lightroom .xmp presets"
                  onClick={pickFiles}
                >Import…</button>
                <button
                  type="button"
                  className="rail-btn"
                  data-tip="Download your presets as one file"
                  disabled={!presets.length}
                  onClick={() => exportPresets(presets)}
                >Export all</button>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  )
}

function PresetGroup({ name, folded, onFold, children }) {
  if (!name) return children
  return (
    <>
      <li className="preset-group">
        <button type="button" className={`preset-group-head${folded ? '' : ' is-open'}`} onClick={onFold} aria-expanded={!folded}>
          <Caret />
          {name}
        </button>
      </li>
      {!folded && children}
    </>
  )
}
