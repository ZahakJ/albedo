import { openPhoto, sendMaskTex } from './renderClient.js'
import { openPhotoState } from './editStore.js'
import { loadOriginal, loadDoc, loadMaskBlob } from './catalogStore.js'
import { decode } from './decodeClient.js'
import { texChannels, pngBlobToMask } from './segmentClient.js'
import { replayPatches } from './removeTool.js'
import { ensureDenoised, resetDenoise } from './denoiseClient.js'
import { ensureProfileSent } from './profileStore.js'

// Opens a catalog photo in the Develop engine: original bytes → (RAW: decode
// worker → mosaic/rgb payload | else: ImageBitmap) → render worker, with any
// saved edit doc applied from the first frame.
export async function openInDevelop(photo) {
  const [{ buffer, name }, savedDoc] = await Promise.all([
    loadOriginal(photo.id),
    loadDoc(photo.id).catch(() => null),
  ])
  let source, width, height
  if (photo.isRaw) {
    source = await decode(photo.id, buffer, name, 'full')
    width = source.width
    height = source.height
  } else {
    source = await createImageBitmap(new Blob([buffer]))
    width = source.width
    height = source.height
  }
  resetDenoise()
  openPhotoState({ id: photo.id, name, width, height, isRaw: !!photo.isRaw }, savedDoc)
  ensureProfileSent(savedDoc?.modules?.look) // before OPEN: messages keep their order
  await openPhoto(photo.id, source, savedDoc)
  if (savedDoc?.modules?.detail?.aiDenoise > 0) ensureDenoised(photo)
  // AI-mask replay: weight blobs live in OPFS beside the doc; the first frame
  // renders without them (weight 0), each MASKTEX then re-merges + redraws
  const aiMasks = (savedDoc?.masks ?? []).filter((m) => m.kind === 'ai')
  if (aiMasks.length) {
    const chans = texChannels(savedDoc.masks)
    await Promise.all(aiMasks.map(async (m) => {
      try {
        const blob = await loadMaskBlob(photo.id, m.id)
        if (!blob || !chans.has(m.id)) return
        const { data, width: mw, height: mh } = await pngBlobToMask(blob)
        sendMaskTex(photo.id, {
          maskId: m.id, channel: chans.get(m.id), width: mw, height: mh, data,
        })
      } catch (err) { console.error('[ai mask] replay', err) }
    }))
  }
  // removal patches: pixels from OPFS, placement from the doc
  if (savedDoc?.modules?.remove?.patches?.length) await replayPatches(photo.id, savedDoc)
}
