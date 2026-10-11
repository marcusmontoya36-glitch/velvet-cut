// IndexedDB storage: media blobs + project JSON. Everything stays in this browser.
const DB_NAME = 'velvetcut', DB_VER = 1;
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('IndexedDB transaction aborted (storage full?)'));
  });
}
export const putMedia = (rec) => tx('media', 'readwrite', s => s.put(rec));
export const getMedia = (id) => tx('media', 'readonly', s => s.get(id));
export const delMedia = (id) => tx('media', 'readwrite', s => s.delete(id));
export const allMediaIds = () => tx('media', 'readonly', s => s.getAllKeys());
export const putProject = (p) => tx('projects', 'readwrite', s => s.put(p));
export const getProject = (id) => tx('projects', 'readonly', s => s.get(id));
export const delProject = (id) => tx('projects', 'readwrite', s => s.delete(id));
export const listProjects = () => tx('projects', 'readonly', s => s.getAll());

// Remove media blobs no project references any more.
export async function gcMedia(extraKeep = []) {
  const projects = await listProjects();
  const keep = new Set(extraKeep);
  for (const p of projects) for (const c of p.clips || []) keep.add(c.mediaId);
  for (const id of await allMediaIds()) if (!keep.has(id)) await delMedia(id);
}
export async function estimate() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}
export async function persist() {
  try { return await navigator.storage.persist(); } catch { return false; }
}
