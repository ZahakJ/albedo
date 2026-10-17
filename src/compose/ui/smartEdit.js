import { openSession } from '../../state/renderClient.js'
import { bindTarget, unbindTarget, getState as getEditState, openPhotoState } from '../../state/editStore.js'
import { setSurface } from '../../state/viewStore.js'
import { getCatalogState } from '../../state/catalogStore.js'
import { openInDevelop } from '../../state/openPhoto.js'
import { getCompose, setEditingSmart, op, fromPhoto } from '../../state/composeClient.js'
import { findNode } from '../model.js'
import { toast } from '../../state/toastStore.js'

// The round trip between Develop and Compose, with no file in between.
//
// Edit in Compose: the photo open in Develop becomes a smart object in a new
// document; the render worker keeps its demosaiced texture for Compose.
//
// Edit in Develop (a smart object): Develop opens the photo Compose holds,
// with the edit store bound to the layer. Every commit updates the layer,
// and Compose re-develops it; the catalog's own edit of that photo is not
// touched. "Back to Compose" returns, and Develop gets its photo back.

export async function editInCompose() {
  const { photo, doc } = getEditState()
  if (!photo || !doc) { toast('Open a photo in Develop first'); return }
  await fromPhoto(photo.id, photo.name, doc)
  setSurface('compose')
}

export async function editSmartInDevelop(node) {
  const s = node.smart
  try {
    const r = await openSession(s.photoId, s.edit)
    const photo = { id: s.photoId, name: s.name ?? node.name, width: r.width, height: r.height, isRaw: !!catalogPhoto(s.photoId)?.isRaw }
    const nodeId = node.id
    bindTarget(photo, s.edit, {
      render: true,
      commit: (edit) => {
        const cur = findNode(getCompose().doc?.nodes ?? [], nodeId)?.node
        if (!cur) return
        op('props', { nodeId, patch: { smart: { ...cur.smart, edit } }, label: 'Smart Object Edit' })
      },
    })
    setEditingSmart({ nodeId, photoId: s.photoId, name: photo.name })
    setSurface('develop')
  } catch (err) {
    toast(`Could not open the smart object: ${err.message}`)
  }
}

export async function backToCompose() {
  unbindTarget()
  setEditingSmart(null)
  setSurface('compose')
  const prev = getEditState().photo
  // Develop's own photo was swapped out for the smart object: bring it back
  if (prev) {
    const p = catalogPhoto(prev.id)
    if (p) openInDevelop(p).catch((err) => console.warn('[develop reopen]', err))
    else openPhotoState(prev, getEditState().doc)
  }
}

const catalogPhoto = (id) => getCatalogState().photos.find((p) => p.id === id) ?? null
