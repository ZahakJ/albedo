import { loadOriginal, loadDoc } from '../../state/catalogStore.js'
import { decode } from '../../state/decodeClient.js'
import { request, fitSoonPublic } from '../../state/composeClient.js'
import { CO } from '../protocol.js'
import { toast } from '../../state/toastStore.js'

// A Library photo into Compose as a smart object: decoded once, developed
// with its saved edit, and re-developable from then on.
export async function placeFromLibrary(photo, { newDoc = false } = {}) {
  if (!photo) return
  try {
    const [{ buffer, name }, edit] = await Promise.all([loadOriginal(photo.id), loadDoc(photo.id).catch(() => null)])
    const source = photo.isRaw ? await decode(photo.id, buffer, name, 'full') : await createImageBitmap(new Blob([buffer]))
    await request({ type: CO.SOURCE, photoId: photo.id, source }, source instanceof ImageBitmap ? [source] : [source.buffer.buffer])
    const editDoc = edit ?? { modules: {}, masks: [] }
    if (newDoc) await request({ type: CO.FROM_PHOTO, photoId: photo.id, name: photo.name, editDoc }).then(fitSoonPublic)
    else await request({ type: CO.ADD_SMART, photoId: photo.id, name: photo.name, editDoc })
  } catch (err) {
    toast(`Could not place ${photo.name}: ${err.message}`)
  }
}
