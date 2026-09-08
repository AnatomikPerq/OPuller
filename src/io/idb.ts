/**
 * Minimal promise-based IndexedDB key/value helper used for autosave and the
 * recent-documents store. Every function resolves gracefully (null / no-op) when
 * IndexedDB is unavailable (private mode, jsdom, ...).
 */

const dbCache = new Map<string, Promise<IDBDatabase | null>>();

function openDb(dbName: string, storeName: string): Promise<IDBDatabase | null> {
  const key = `${dbName}/${storeName}`;
  let p = dbCache.get(key);
  if (p) return p;
  p = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbCache.delete(key);
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  dbCache.set(key, p);
  return p;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface KVStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<boolean>;
}

/** A key/value store backed by one object store of one database. */
export function kvStore(dbName: string, storeName: string): KVStore {
  const withStore = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const db = await openDb(dbName, storeName);
    if (!db) return null;
    try {
      const tx = db.transaction(storeName, mode);
      const res = await request(fn(tx.objectStore(storeName)));
      return res;
    } catch {
      return null;
    }
  };
  return {
    async get<T>(key: string): Promise<T | null> {
      const v = await withStore<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
      return v === undefined ? null : v;
    },
    async set(key: string, value: unknown): Promise<boolean> {
      const r = await withStore('readwrite', (s) => s.put(value, key));
      return r !== null;
    },
    async delete(key: string): Promise<boolean> {
      const db = await openDb(dbName, storeName);
      if (!db) return false;
      try {
        const tx = db.transaction(storeName, 'readwrite');
        await request(tx.objectStore(storeName).delete(key));
        return true;
      } catch {
        return false;
      }
    },
    async keys(): Promise<string[]> {
      const r = await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
      return (r ?? []).map(String);
    },
    async clear(): Promise<boolean> {
      const db = await openDb(dbName, storeName);
      if (!db) return false;
      try {
        const tx = db.transaction(storeName, 'readwrite');
        await request(tx.objectStore(storeName).clear());
        return true;
      } catch {
        return false;
      }
    },
  };
}
