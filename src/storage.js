const DB_NAME = "glquake2-display";
const DB_VERSION = 1;
const STORE_NAME = "packages";
const PAK_KEY = "baseq2/pak0.pak";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, callback) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error);
      })
  );
}

export async function savePakFile(file) {
  const record = {
    key: PAK_KEY,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    updatedAt: new Date().toISOString(),
    blob: file
  };

  await withStore("readwrite", (store) => store.put(record));
  return record;
}

export async function getPakInfo() {
  const record = await withStore("readonly", (store) => store.get(PAK_KEY));
  if (!record) {
    return null;
  }

  return {
    name: record.name,
    size: record.size,
    updatedAt: record.updatedAt
  };
}

export async function readPakBytes() {
  const record = await withStore("readonly", (store) => store.get(PAK_KEY));
  if (!record?.blob) {
    return null;
  }

  return new Uint8Array(await record.blob.arrayBuffer());
}

export async function clearPakFile() {
  await withStore("readwrite", (store) => store.delete(PAK_KEY));
}

export function formatBytes(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;

  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }

  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
