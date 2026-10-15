import { useEffect, useState } from 'react'
import {
  useVersions, refreshVersions, createVersion, switchVersion,
  renameVersion, deleteVersion, versionLabel,
} from '../state/versionStore.js'

// VERSIONS panel section — virtual copies of the current photo. Click a row
// to switch (params only, no re-decode), double-click a name to rename,
// × deletes (never the last one). The amber tick marks the active version.

export default function VersionsSection({ photo, doc }) {
  const { versions } = useVersions()
  const current = doc?.versionId ?? 'v_default'
  const [editing, setEditing] = useState(null) // { versionId, name } | null

  useEffect(() => {
    setEditing(null)
    refreshVersions(photo?.id ?? null)
  }, [photo?.id])

  if (!photo || !doc) return <p className="ver-empty">No photo open</p>

  return (
    <div className="ver-list">
      {versions.map((v) => (
        <div
          key={v.versionId}
          className={`ver-row${v.versionId === current ? ' is-current' : ''}`}
          onClick={() => { if (editing?.versionId !== v.versionId) switchVersion(v.versionId) }}
          onDoubleClick={() => setEditing({ versionId: v.versionId, name: versionLabel(v) })}
        >
          <span className="ver-tick" aria-hidden="true" />
          {editing?.versionId === v.versionId ? (
            <input
              className="ver-edit mono"
              autoFocus
              value={editing.name}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditing({ versionId: v.versionId, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = editing.name.trim()
                  if (n) renameVersion(v.versionId, n)
                  setEditing(null)
                } else if (e.key === 'Escape') setEditing(null)
                e.stopPropagation()
              }}
              onBlur={() => setEditing(null)}
            />
          ) : (
            <span className="ver-name" title="Double-click to rename">{versionLabel(v)}</span>
          )}
          {versions.length > 1 && (
            <button
              type="button"
              className="ver-del"
              title="Delete version"
              onClick={(e) => { e.stopPropagation(); deleteVersion(v.versionId) }}
            >×</button>
          )}
        </div>
      ))}
      <button type="button" className="ver-new" onClick={() => createVersion()}>
        + New version
      </button>
    </div>
  )
}
