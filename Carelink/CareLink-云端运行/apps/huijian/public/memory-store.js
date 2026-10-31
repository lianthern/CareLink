// 回见本机记忆：只写入当前浏览器的 IndexedDB，不代表账号或云同步。

export const MEMORY_DB_NAME = "huijian";
export const MEMORY_DB_VERSION = 2;
export const MEMORY_STORE_NAMES = Object.freeze({
  memories: "memories",
  collections: "collections",
  styleProfiles: "styleProfiles"
});

export const RESULT_SHAPES = Object.freeze([
  "memory-page",
  "poster",
  "zine",
  "spatial"
]);

export const STYLE_IDS = Object.freeze([
  "evening-paper",
  "black-fragments",
  "quiet-white"
]);

const DEFAULT_STYLE_ID = "evening-paper";
const COLLECTION_NAME_LIMIT = 48;
const MAX_MEMORY_PHOTOS = 24;

export class MemoryStoreUnavailableError extends Error {
  constructor(reason = "indexeddb_unavailable", cause) {
    super("本机记忆存储不可用");
    this.name = "MemoryStoreUnavailableError";
    this.code = reason;
    if (cause) this.cause = cause;
  }
}

export function memoryStoreCapability(indexedDb = globalThis.indexedDB) {
  if (!indexedDb || typeof indexedDb.open !== "function") {
    return {
      available: false,
      persistence: "none",
      reason: "indexeddb_unavailable"
    };
  }
  return {
    available: true,
    persistence: "device-browser",
    reason: ""
  };
}

export function defaultCollectionId(year = new Date().getFullYear()) {
  const safeYear = Number.isFinite(Number(year)) ? Math.trunc(Number(year)) : new Date().getFullYear();
  return `year:${safeYear}`;
}

export function defaultCollectionName(year = new Date().getFullYear(), currentYear = new Date().getFullYear()) {
  const safeYear = Number.isFinite(Number(year)) ? Math.trunc(Number(year)) : new Date().getFullYear();
  return safeYear === Number(currentYear) ? "这一年" : `${safeYear} 年`;
}

export function normalizeStyleId(value, fallback = DEFAULT_STYLE_ID) {
  if (STYLE_IDS.includes(value)) return value;
  return STYLE_IDS.includes(fallback) ? fallback : DEFAULT_STYLE_ID;
}

export function normalizeResultShape(value, fallback = "memory-page") {
  if (RESULT_SHAPES.includes(value)) return value;
  return RESULT_SHAPES.includes(fallback) ? fallback : "memory-page";
}

export function normalizeCollectionName(value) {
  const name = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (!name) throw new TypeError("collection_name_required");
  if ([...name].length > COLLECTION_NAME_LIMIT) throw new TypeError("collection_name_too_long");
  return name;
}

export function sortRecentlyUpdated(records) {
  return [...records].sort((left, right) => {
    const byUpdate = finiteTime(right.updatedAt) - finiteTime(left.updatedAt);
    if (byUpdate) return byUpdate;
    const byCreate = finiteTime(right.createdAt) - finiteTime(left.createdAt);
    if (byCreate) return byCreate;
    return String(left.id ?? "").localeCompare(String(right.id ?? ""), "zh-CN");
  });
}

export function inheritedStyleId(requestedStyleId, styleProfile) {
  if (STYLE_IDS.includes(requestedStyleId)) return requestedStyleId;
  return normalizeStyleId(styleProfile?.styleId);
}

export function legacyPhotoToMemory(photo, {
  currentYear = new Date().getFullYear(),
  migratedAt = Date.now()
} = {}) {
  if (!photo?.id || !photo?.dataUrl) return null;
  const capturedAt = finiteTime(photo.ts, migratedAt);
  const year = new Date(capturedAt).getFullYear();
  const collectionId = defaultCollectionId(year);
  return {
    memory: {
      id: `legacy:${photo.id}`,
      collectionId,
      photos: [{
        id: String(photo.id),
        src: photo.dataUrl,
        capturedAt
      }],
      facts: [],
      question: "",
      answer: "",
      pairs: [],
      capturedAt,
      createdAt: capturedAt,
      updatedAt: migratedAt,
      resultShape: "memory-page",
      styleId: DEFAULT_STYLE_ID,
      origin: "legacy-album",
      version: MEMORY_DB_VERSION
    },
    collection: {
      id: collectionId,
      name: defaultCollectionName(year, currentYear),
      createdAt: capturedAt,
      updatedAt: migratedAt,
      version: MEMORY_DB_VERSION
    },
    styleProfile: {
      collectionId,
      styleId: DEFAULT_STYLE_ID,
      updatedAt: migratedAt,
      version: MEMORY_DB_VERSION
    }
  };
}

export function createMemoryRepository(adapter, {
  now = () => Date.now(),
  createId = defaultId,
  currentYear = new Date().getFullYear()
} = {}) {
  if (!adapter || typeof adapter.transaction !== "function") {
    throw new TypeError("memory_adapter_required");
  }

  const year = Number.isFinite(Number(currentYear))
    ? Math.trunc(Number(currentYear))
    : new Date().getFullYear();
  const defaultId = defaultCollectionId(year);

  async function ensureDefaultCollection() {
    const timestamp = finiteTime(now());
    return adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.styleProfiles],
      "readwrite",
      async (stores) => {
        let collection = await stores.get(MEMORY_STORE_NAMES.collections, defaultId);
        if (!collection) {
          collection = collectionRecord({
            id: defaultId,
            name: defaultCollectionName(year, year),
            timestamp
          });
          await stores.put(MEMORY_STORE_NAMES.collections, collection);
        }
        const profile = await stores.get(MEMORY_STORE_NAMES.styleProfiles, defaultId);
        if (!profile) {
          await stores.put(MEMORY_STORE_NAMES.styleProfiles, styleProfileRecord({
            collectionId: defaultId,
            styleId: DEFAULT_STYLE_ID,
            timestamp
          }));
        }
        return collection;
      }
    );
  }

  async function createCollection({ name, styleId = DEFAULT_STYLE_ID } = {}) {
    const timestamp = finiteTime(now());
    const id = String(createId("collection"));
    const collection = collectionRecord({
      id,
      name: normalizeCollectionName(name),
      timestamp
    });
    const profile = styleProfileRecord({
      collectionId: id,
      styleId: normalizeStyleId(styleId),
      timestamp
    });
    return adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.styleProfiles],
      "readwrite",
      async (stores) => {
        await stores.put(MEMORY_STORE_NAMES.collections, collection);
        await stores.put(MEMORY_STORE_NAMES.styleProfiles, profile);
        return { ...collection, styleId: profile.styleId, memoryCount: 0, coverPhoto: null };
      }
    );
  }

  async function renameCollection(collectionId, name) {
    const id = String(collectionId);
    const nextName = normalizeCollectionName(name);
    const timestamp = finiteTime(now());
    return adapter.transaction([MEMORY_STORE_NAMES.collections], "readwrite", async (stores) => {
      const collection = await stores.get(MEMORY_STORE_NAMES.collections, id);
      if (!collection) throw new Error("collection_not_found");
      const updated = { ...collection, name: nextName, updatedAt: timestamp };
      await stores.put(MEMORY_STORE_NAMES.collections, updated);
      return updated;
    });
  }

  async function listCollections() {
    return adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.memories, MEMORY_STORE_NAMES.styleProfiles],
      "readonly",
      async (stores) => {
        const [collections, memories, profiles] = await Promise.all([
          stores.getAll(MEMORY_STORE_NAMES.collections),
          stores.getAll(MEMORY_STORE_NAMES.memories),
          stores.getAll(MEMORY_STORE_NAMES.styleProfiles)
        ]);
        const profilesByCollection = new Map(profiles.map((profile) => [profile.collectionId, profile]));
        return sortRecentlyUpdated(collections.map((collection) => {
          const members = sortRecentlyUpdated(memories.filter((memory) => memory.collectionId === collection.id));
          const newest = members[0];
          return {
            ...collection,
            updatedAt: Math.max(finiteTime(collection.updatedAt), finiteTime(newest?.updatedAt)),
            memoryCount: members.length,
            coverMemoryId: newest?.id ?? null,
            coverPhoto: newest?.photos?.[0] ?? null,
            styleId: normalizeStyleId(profilesByCollection.get(collection.id)?.styleId)
          };
        }));
      }
    );
  }

  async function getCollection(collectionId) {
    const id = String(collectionId);
    const collections = await listCollections();
    return collections.find((collection) => collection.id === id) ?? null;
  }

  async function getStyleProfile(collectionId) {
    const id = String(collectionId);
    return adapter.transaction([MEMORY_STORE_NAMES.styleProfiles], "readonly", async (stores) => {
      const profile = await stores.get(MEMORY_STORE_NAMES.styleProfiles, id);
      return profile ?? null;
    });
  }

  async function setCollectionStyle(collectionId, styleId) {
    const id = String(collectionId);
    const timestamp = finiteTime(now());
    const normalizedStyle = normalizeStyleId(styleId);
    return adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.styleProfiles],
      "readwrite",
      async (stores) => {
        const collection = await stores.get(MEMORY_STORE_NAMES.collections, id);
        if (!collection) throw new Error("collection_not_found");
        const profile = styleProfileRecord({ collectionId: id, styleId: normalizedStyle, timestamp });
        await stores.put(MEMORY_STORE_NAMES.styleProfiles, profile);
        await stores.put(MEMORY_STORE_NAMES.collections, { ...collection, updatedAt: timestamp });
        return profile;
      }
    );
  }

  async function resolveStyleForCollection(collectionId, requestedStyleId) {
    const profile = await getStyleProfile(collectionId);
    return inheritedStyleId(requestedStyleId, profile);
  }

  async function saveMemory(input, {
    collectionId = defaultId,
    rememberStyle = true,
    createOnly = false
  } = {}) {
    const targetCollectionId = String(input?.collectionId ?? collectionId);
    const timestamp = finiteTime(now());
    return adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.memories, MEMORY_STORE_NAMES.styleProfiles],
      "readwrite",
      async (stores) => {
        const collection = await stores.get(MEMORY_STORE_NAMES.collections, targetCollectionId);
        if (!collection) throw new Error("collection_not_found");
        const profile = await stores.get(MEMORY_STORE_NAMES.styleProfiles, targetCollectionId);
        const existingId = input?.id ? String(input.id) : "";
        const existing = existingId
          ? await stores.get(MEMORY_STORE_NAMES.memories, existingId)
          : null;
        if(createOnly&&existing)throw new Error("local_copy_exists");
        const retainedStyle = existing?.collectionId === targetCollectionId ? existing.styleId : undefined;
        const styleId = inheritedStyleId(input?.styleId ?? retainedStyle, profile);
        const memory = memoryRecord(input, {
          id: existingId || String(createId("memory")),
          collectionId: targetCollectionId,
          styleId,
          timestamp,
          existing
        });
        await stores.put(MEMORY_STORE_NAMES.memories, memory);
        await stores.put(MEMORY_STORE_NAMES.collections, { ...collection, updatedAt: timestamp });
        const explicitlySelectedStyle = STYLE_IDS.includes(input?.styleId);
        if (rememberStyle && explicitlySelectedStyle && (!profile || profile.styleId !== styleId)) {
          await stores.put(MEMORY_STORE_NAMES.styleProfiles, styleProfileRecord({
            collectionId: targetCollectionId,
            styleId,
            timestamp
          }));
        }
        return memory;
      }
    );
  }

  // Metadata advances only for the exact local snapshot acknowledged by canonical.
  // A concurrent local edit retains its earlier basis and must resolve a conflict.
  async function markMemorySynced(memoryId, accountId, version, snapshot) {
    if (!accountId || !Number.isInteger(version) || version < 1) throw new TypeError("sync_receipt_invalid");
    return adapter.transaction([MEMORY_STORE_NAMES.memories], "readwrite", async stores => {
      const current = await stores.get(MEMORY_STORE_NAMES.memories, String(memoryId));
      if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) return null;
      const updated = {...current, syncBases: {...current.syncBases, [accountId]: version}};
      await stores.put(MEMORY_STORE_NAMES.memories, updated);
      return updated;
    });
  }

  async function appendMemories(collectionId, inputs, options = {}) {
    const results = [];
    for (const input of inputs ?? []) {
      results.push(await saveMemory(input, { ...options, collectionId }));
    }
    return results;
  }

  async function getMemory(memoryId) {
    const id = String(memoryId);
    return adapter.transaction([MEMORY_STORE_NAMES.memories], "readonly", (stores) => (
      stores.get(MEMORY_STORE_NAMES.memories, id)
    ));
  }

  async function listMemories(collectionId) {
    const id = String(collectionId);
    return adapter.transaction([MEMORY_STORE_NAMES.memories], "readonly", async (stores) => {
      const records = await stores.getAllByIndex(MEMORY_STORE_NAMES.memories, "by-collection", id);
      return sortRecentlyUpdated(records);
    });
  }

  async function deleteMemory(memoryId) {
    const id = String(memoryId);
    const timestamp = finiteTime(now());
    return adapter.transaction(
      [MEMORY_STORE_NAMES.memories, MEMORY_STORE_NAMES.collections],
      "readwrite",
      async (stores) => {
        const memory = await stores.get(MEMORY_STORE_NAMES.memories, id);
        if (!memory) return false;
        await stores.delete(MEMORY_STORE_NAMES.memories, id);
        const collection = await stores.get(MEMORY_STORE_NAMES.collections, memory.collectionId);
        if (collection) {
          await stores.put(MEMORY_STORE_NAMES.collections, { ...collection, updatedAt: timestamp });
        }
        return true;
      }
    );
  }

  async function deleteCollection(collectionId) {
    const id = String(collectionId);
    const timestamp = finiteTime(now());
    const removal = await adapter.transaction(
      [MEMORY_STORE_NAMES.collections, MEMORY_STORE_NAMES.memories, MEMORY_STORE_NAMES.styleProfiles],
      "readwrite",
      async (stores) => {
        const collection = await stores.get(MEMORY_STORE_NAMES.collections, id);
        if (!collection) return { found: false, memoryCount: 0 };
        const memories = await stores.getAllByIndex(MEMORY_STORE_NAMES.memories, "by-collection", id);
        for (const memory of memories) await stores.delete(MEMORY_STORE_NAMES.memories, memory.id);
        await stores.delete(MEMORY_STORE_NAMES.styleProfiles, id);
        await stores.delete(MEMORY_STORE_NAMES.collections, id);
        if (id === defaultId) {
          await stores.put(MEMORY_STORE_NAMES.collections, collectionRecord({
            id: defaultId,
            name: defaultCollectionName(year, year),
            timestamp
          }));
          await stores.put(MEMORY_STORE_NAMES.styleProfiles, styleProfileRecord({
            collectionId: defaultId,
            styleId: DEFAULT_STYLE_ID,
            timestamp
          }));
        }
        return { found: true, memoryCount: memories.length };
      }
    );
    return {
      deleted: removal.found,
      memoryCount: removal.memoryCount,
      recreatedDefault: removal.found && id === defaultId
    };
  }

  return Object.freeze({
    available: true,
    persistence: "device-browser",
    reason: "",
    defaultCollectionId: defaultId,
    ensureDefaultCollection,
    createCollection,
    renameCollection,
    listCollections,
    getCollection,
    getStyleProfile,
    setCollectionStyle,
    resolveStyleForCollection,
    saveMemory,
    markMemorySynced,
    appendMemories,
    getMemory,
    listMemories,
    deleteMemory,
    deleteCollection,
    close: () => adapter.close?.()
  });
}

export async function openMemoryStore({
  indexedDB: indexedDb = globalThis.indexedDB,
  now,
  createId,
  currentYear = new Date().getFullYear()
} = {}) {
  const capability = memoryStoreCapability(indexedDb);
  if (!capability.available) return unavailableRepository(capability.reason);
  let repository;
  try {
    const database = await openDatabase(indexedDb, { currentYear, now: now?.() ?? Date.now() });
    repository = createMemoryRepository(createIndexedDbAdapter(database), {
      now,
      createId,
      currentYear
    });
    await repository.ensureDefaultCollection();
    return repository;
  } catch (error) {
    repository?.close();
    return unavailableRepository("indexeddb_open_failed", error);
  }
}

function unavailableRepository(reason, cause) {
  const error = new MemoryStoreUnavailableError(reason, cause);
  const reject = () => Promise.reject(error);
  return Object.freeze({
    available: false,
    persistence: "none",
    reason,
    defaultCollectionId: null,
    ensureDefaultCollection: reject,
    createCollection: reject,
    renameCollection: reject,
    listCollections: reject,
    getCollection: reject,
    getStyleProfile: reject,
    setCollectionStyle: reject,
    resolveStyleForCollection: reject,
    saveMemory: reject,
    markMemorySynced: reject,
    appendMemories: reject,
    getMemory: reject,
    listMemories: reject,
    deleteMemory: reject,
    deleteCollection: reject,
    close() {}
  });
}

function openDatabase(indexedDb, { currentYear, now }) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(MEMORY_DB_NAME, MEMORY_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      const memories = ensureObjectStore(database, transaction, MEMORY_STORE_NAMES.memories, { keyPath: "id" });
      ensureIndex(memories, "by-collection", "collectionId");
      ensureIndex(memories, "by-updated", "updatedAt");
      const collections = ensureObjectStore(database, transaction, MEMORY_STORE_NAMES.collections, { keyPath: "id" });
      ensureIndex(collections, "by-updated", "updatedAt");
      const styles = ensureObjectStore(database, transaction, MEMORY_STORE_NAMES.styleProfiles, { keyPath: "collectionId" });

      if (event.oldVersion < 2 && database.objectStoreNames.contains("photos")) {
        const legacy = transaction.objectStore("photos");
        const cursorRequest = legacy.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const migrated = legacyPhotoToMemory(cursor.value, { currentYear, migratedAt: now });
          if (migrated) {
            memories.put(migrated.memory);
            collections.put(migrated.collection);
            styles.put(migrated.styleProfile);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onblocked = () => reject(new Error("indexeddb_upgrade_blocked"));
  });
}

function ensureObjectStore(database, transaction, name, options) {
  return database.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : database.createObjectStore(name, options);
}

function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

function createIndexedDbAdapter(database) {
  return {
    async transaction(storeNames, mode, run) {
      const transaction = database.transaction(storeNames, mode);
      const completed = transactionComplete(transaction);
      const stores = {
        get: (storeName, key) => requestValue(transaction.objectStore(storeName).get(key)),
        getAll: (storeName) => requestValue(transaction.objectStore(storeName).getAll()),
        getAllByIndex: (storeName, indexName, value) => (
          requestValue(transaction.objectStore(storeName).index(indexName).getAll(value))
        ),
        put: (storeName, value) => requestValue(transaction.objectStore(storeName).put(value)),
        delete: (storeName, key) => requestValue(transaction.objectStore(storeName).delete(key))
      };
      try {
        const result = await run(stores);
        await completed;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction may already have stopped */ }
        await completed.catch(() => {});
        throw error;
      }
    },
    close: () => database.close()
  };
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("indexeddb_transaction_failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("indexeddb_transaction_aborted"));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
  });
}

function collectionRecord({ id, name, timestamp }) {
  return {
    id: String(id),
    name: normalizeCollectionName(name),
    createdAt: finiteTime(timestamp),
    updatedAt: finiteTime(timestamp),
    version: MEMORY_DB_VERSION
  };
}

function styleProfileRecord({ collectionId, styleId, timestamp }) {
  return {
    collectionId: String(collectionId),
    styleId: normalizeStyleId(styleId),
    updatedAt: finiteTime(timestamp),
    version: MEMORY_DB_VERSION
  };
}

function memoryRecord(input, { id, collectionId, styleId, timestamp, existing }) {
  const inputPhotos = Array.isArray(input?.photos) ? input.photos : existing?.photos;
  const photos = Array.isArray(inputPhotos)
    ? inputPhotos.map((photo, index) => normalizePhoto(photo, index, timestamp)).filter(Boolean)
    : [];
  if (!photos.length) throw new TypeError("memory_photos_required");
  if (photos.length > MAX_MEMORY_PHOTOS) throw new RangeError("memory_photos_exceed_limit");
  const resultShape = normalizeResultShape(
    input?.resultShape ?? input?.shape ?? existing?.resultShape ?? existing?.shape
  );
  if (resultShape === "zine" && photos.length < 2) throw new RangeError("zine_requires_multiple_photos");
  const createdAt = finiteTime(existing?.createdAt, finiteTime(input?.createdAt, timestamp));
  const inputPairs = Array.isArray(input?.pairs) ? input.pairs : existing?.pairs;
  const pairs = Array.isArray(inputPairs)
    ? inputPairs.map(normalizePair).filter(Boolean)
    : [];
  return {
    ...existing,
    syncBases: { ...(input?.syncBases ?? existing?.syncBases ?? {}) },
    pageAspect: ['portrait','landscape','square'].includes(input?.pageAspect) ? input.pageAspect : input?.pageAspect === '' ? '' : existing?.pageAspect || '',
    mainPhotoId: input?.mainPhotoId ?? existing?.mainPhotoId ?? photos[0]?.id,
    activePairId: input?.activePairId ?? existing?.activePairId ?? null,
    title: input?.title === undefined ? existing?.title || "" : cleanText(input.title),
    deletedAt: input?.deletedAt === undefined ? existing?.deletedAt || null : input.deletedAt,
    id,
    collectionId,
    photos,
    facts: input?.facts === undefined && input?.visibleFacts === undefined
      ? stringList(existing?.facts ?? existing?.visibleFacts)
      : stringList(input?.facts ?? input?.visibleFacts),
    question: input?.question === undefined ? cleanText(existing?.question) : cleanText(input.question),
    answer: input?.answer === undefined ? cleanText(existing?.answer) : cleanText(input.answer),
    pairs,
    capturedAt: finiteTime(input?.capturedAt, photos[0]?.capturedAt ?? createdAt),
    createdAt,
    updatedAt: timestamp,
    resultShape,
    styleId,
    origin: cleanText(input?.origin) || existing?.origin || "huijian-vnext",
    version: MEMORY_DB_VERSION
  };
}

function normalizePhoto(photo, index, fallbackTime = Date.now()) {
  const src = cleanText(photo?.src ?? photo?.dataUrl);
  if (!src) return null;
  return {
    ...photo,
    id: cleanText(photo?.id ?? photo?.key) || `photo:${index}`,
    src,
    capturedAt: finiteTime(photo?.capturedAt ?? photo?.ts, fallbackTime),
    width: positiveNumber(photo?.width),
    height: positiveNumber(photo?.height)
  };
}

function normalizePair(pair) {
  const question = cleanText(pair?.question);
  const answer = cleanText(pair?.answer);
  return question || answer ? { ...pair, question, answer } : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteTime(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) return number;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${suffix}`;
}
