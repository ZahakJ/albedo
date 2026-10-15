// OPFS helpers for the catalog worker. createSyncAccessHandle only exists in
// dedicated workers, so every writer here assumes worker context.

let rootPromise = null
const root = () => (rootPromise ??= navigator.storage.getDirectory())

// 'a/b/c' → dir handle for a/b/c, creating intermediates when create=true.
export async function getDir(path, create = true) {
  let dir = await root()
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir
}

const splitPath = (path) => {
  const parts = path.split('/').filter(Boolean)
  return [parts.slice(0, -1).join('/'), parts[parts.length - 1]]
}

// Sync handle: one flush+close makes the write durable before we insert the
// catalog row, so the DB never points at a half-written original.
export async function writeFile(path, data) {
  const [dirPath, name] = splitPath(path)
  const dir = await getDir(dirPath)
  const fh = await dir.getFileHandle(name, { create: true })
  const h = await fh.createSyncAccessHandle()
  try {
    h.truncate(0)
    h.write(ArrayBuffer.isView(data) ? data : new Uint8Array(data), { at: 0 })
    h.flush()
  } finally {
    h.close()
  }
}

// Write tmp then rename so a crash mid-write never leaves a torn target.
// move() is Chromium-only today; the fallback double-write is not atomic but
// still leaves a recoverable tmp copy.
export async function writeFileAtomic(path, data) {
  const [dirPath, name] = splitPath(path)
  const tmp = `${path}.tmp`
  await writeFile(tmp, data)
  const dir = await getDir(dirPath)
  const tmpHandle = await dir.getFileHandle(`${name}.tmp`)
  if (typeof tmpHandle.move === 'function') {
    await tmpHandle.move(name)
  } else {
    await writeFile(path, data)
    await dir.removeEntry(`${name}.tmp`).catch(() => {})
  }
}

export async function readFile(path) {
  const [dirPath, name] = splitPath(path)
  const dir = await getDir(dirPath, false)
  const fh = await dir.getFileHandle(name)
  return (await fh.getFile()).arrayBuffer()
}

export async function readFileBlob(path) {
  const [dirPath, name] = splitPath(path)
  const dir = await getDir(dirPath, false)
  const fh = await dir.getFileHandle(name)
  return fh.getFile()
}

// Best-effort removals for photo deletion: a missing entry is success — the
// caller only cares that the bytes are gone afterwards.
export async function deleteFile(path) {
  try {
    const [dirPath, name] = splitPath(path)
    const dir = await getDir(dirPath, false)
    await dir.removeEntry(name)
  } catch { /* already gone (or never written) */ }
}

export async function deleteDir(path) {
  try {
    const parts = path.split('/').filter(Boolean)
    const parent = await getDir(parts.slice(0, -1).join('/'), false)
    await parent.removeEntry(parts[parts.length - 1], { recursive: true })
  } catch { /* already gone */ }
}

export async function exists(path) {
  try {
    const [dirPath, name] = splitPath(path)
    const dir = await getDir(dirPath, false)
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}
