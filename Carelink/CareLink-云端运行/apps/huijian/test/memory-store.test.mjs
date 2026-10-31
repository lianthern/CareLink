import test from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_STORE_NAMES,
  MemoryStoreUnavailableError,
  createMemoryRepository,
  defaultCollectionId,
  defaultCollectionName,
  inheritedStyleId,
  legacyPhotoToMemory,
  memoryStoreCapability,
  normalizeResultShape,
  normalizeStyleId,
  normalizeCollectionName,
  openMemoryStore,
  sortRecentlyUpdated
} from "../public/memory-store.js";

test("pure helpers keep stable year, style, names and recent ordering", () => {
  assert.equal(defaultCollectionId(2026), "year:2026");
  assert.equal(defaultCollectionName(2026, 2026), "这一年");
  assert.equal(defaultCollectionName(2025, 2026), "2025 年");
  assert.equal(inheritedStyleId(undefined, { styleId: "black-fragments" }), "black-fragments");
  assert.equal(inheritedStyleId("quiet-white", { styleId: "black-fragments" }), "quiet-white");
  assert.equal(inheritedStyleId("made-up", { styleId: "made-up" }), "evening-paper");
  assert.equal(normalizeStyleId("made-up", "also-made-up"), "evening-paper");
  assert.equal(normalizeResultShape("made-up", "also-made-up"), "memory-page");
  assert.equal(normalizeCollectionName("  北海道   冬天 "), "北海道 冬天");
  assert.throws(() => normalizeCollectionName("   "), /collection_name_required/u);
  assert.deepEqual(
    sortRecentlyUpdated([
      { id: "older", createdAt: 1, updatedAt: 10 },
      { id: "newer", createdAt: 2, updatedAt: 20 }
    ]).map(({ id }) => id),
    ["newer", "older"]
  );
});

test("legacy album photos become local memories without inventing dialogue", () => {
  const migrated = legacyPhotoToMemory({
    id: "photo-1",
    dataUrl: "data:image/jpeg;base64,abc",
    ts: Date.UTC(2025, 3, 2)
  }, {
    currentYear: 2026,
    migratedAt: Date.UTC(2026, 8, 1)
  });

  assert.equal(migrated.collection.id, "year:2025");
  assert.equal(migrated.collection.name, "2025 年");
  assert.equal(migrated.memory.origin, "legacy-album");
  assert.equal(migrated.memory.resultShape, "memory-page");
  assert.equal(migrated.memory.answer, "");
  assert.deepEqual(migrated.memory.facts, []);
  assert.equal(migrated.memory.photos[0].src, "data:image/jpeg;base64,abc");
  assert.equal(legacyPhotoToMemory({ id: "missing-photo" }), null);
});

test("missing IndexedDB is an explicit unavailable adapter and never a fake save", async () => {
  assert.deepEqual(memoryStoreCapability(undefined), {
    available: false,
    persistence: "none",
    reason: "indexeddb_unavailable"
  });
  const store = await openMemoryStore({ indexedDB: null });
  assert.equal(store.available, false);
  assert.equal(store.persistence, "none");
  assert.equal(store.reason, "indexeddb_unavailable");
  await assert.rejects(store.saveMemory({}), (error) => {
    assert.ok(error instanceof MemoryStoreUnavailableError);
    assert.equal(error.code, "indexeddb_unavailable");
    return true;
  });

  const blocked = await openMemoryStore({
    indexedDB: { open() { throw new DOMException("blocked", "SecurityError"); } }
  });
  assert.equal(blocked.available, false);
  assert.equal(blocked.reason, "indexeddb_open_failed");
});

test("repository saves, reopens and appends memories with inherited collection style", async () => {
  const adapter = createMemoryAdapter();
  let timestamp = 1000;
  let id = 0;
  const store = createMemoryRepository(adapter, {
    currentYear: 2026,
    now: () => timestamp,
    createId: (prefix) => `${prefix}:test-${++id}`
  });

  const base = await store.ensureDefaultCollection();
  assert.equal(base.id, "year:2026");
  assert.equal(base.name, "这一年");

  const first = await store.saveMemory({
    photos: [
      { id: "p1", src: "data:image/jpeg;base64,one", capturedAt: 900 },
      { id: "p1-extra", src: "data:image/jpeg;base64,extra", capturedAt: 901 }
    ],
    facts: ["两个人在碰杯"],
    question: "那天最想留下什么？",
    answer: "风很暖。",
    resultShape: "poster",
    styleId: "black-fragments",
    createdAt: "1970-01-01T00:00:00.500Z"
  });
  assert.equal(first.id, "memory:test-1");
  assert.equal(first.photos.length, 2, "single-page shapes must still preserve every selected photo");
  assert.equal(first.styleId, "black-fragments");
  assert.equal(first.createdAt, 500);
  assert.equal((await store.getStyleProfile(base.id)).styleId, "black-fragments");

  timestamp = 2000;
  const [second] = await store.appendMemories(base.id, [{
    photos: [{ id: "p2", src: "data:image/jpeg;base64,two", capturedAt: 1900 }],
    question: "后来呢？",
    answer: "我们又回去了。"
  }]);
  assert.equal(second.styleId, "black-fragments");

  const reopened = await store.getMemory(first.id);
  assert.equal(reopened.answer, "风很暖。");
  timestamp = 2100;
  const edited = await store.saveMemory({ id: first.id, shape: "memory-page" });
  assert.equal(edited.photos.length, 2);
  assert.equal(edited.answer, "风很暖。");
  assert.deepEqual((await store.listMemories(base.id)).map((memory) => memory.id), [first.id, second.id]);

  const [collection] = await store.listCollections();
  assert.equal(collection.id, base.id);
  assert.equal(collection.memoryCount, 2);
  assert.equal(collection.coverMemoryId, first.id);
  assert.equal(collection.coverPhoto.src, "data:image/jpeg;base64,one");
  assert.equal(collection.styleId, "black-fragments");
});

test("collection rename and cascade delete are truthful; default collection is restored empty", async () => {
  const adapter = createMemoryAdapter();
  let timestamp = 3000;
  let id = 0;
  const store = createMemoryRepository(adapter, {
    currentYear: 2026,
    now: () => timestamp,
    createId: (prefix) => `${prefix}:test-${++id}`
  });
  await store.ensureDefaultCollection();
  const trip = await store.createCollection({ name: "北海道", styleId: "quiet-white" });
  await store.appendMemories(trip.id, [
    { photos: [{ dataUrl: "data:image/jpeg;base64,a" }] },
    { photos: [{ dataUrl: "data:image/jpeg;base64,b" }] }
  ]);

  timestamp = 4000;
  const renamed = await store.renameCollection(trip.id, "北海道 · 冬");
  assert.equal(renamed.name, "北海道 · 冬");
  assert.equal((await store.getCollection(trip.id)).memoryCount, 2);

  const removed = await store.deleteCollection(trip.id);
  assert.deepEqual(removed, { deleted: true, memoryCount: 2, recreatedDefault: false });
  assert.equal(await store.getCollection(trip.id), null);
  assert.equal((await store.listMemories(trip.id)).length, 0);
  assert.deepEqual(await store.deleteCollection("collection:missing"), {
    deleted: false,
    memoryCount: 0,
    recreatedDefault: false
  });

  await store.saveMemory({
    photos: [{ dataUrl: "data:image/jpeg;base64,default" }],
    styleId: "black-fragments"
  });
  timestamp = 5000;
  const reset = await store.deleteCollection("year:2026");
  assert.deepEqual(reset, { deleted: true, memoryCount: 1, recreatedDefault: true });
  const freshDefault = await store.getCollection("year:2026");
  assert.equal(freshDefault.name, "这一年");
  assert.equal(freshDefault.memoryCount, 0);
  assert.equal(freshDefault.styleId, "evening-paper");
});

test("repository refuses impossible persisted photo and zine ranges", async () => {
  const store = createMemoryRepository(createMemoryAdapter(), { currentYear: 2026 });
  await store.ensureDefaultCollection();
  await assert.rejects(store.saveMemory({
    photos: [{ src: "data:image/jpeg;base64,one" }],
    resultShape: "zine"
  }), /zine_requires_multiple_photos/u);
  await assert.rejects(store.saveMemory({
    photos: Array.from({ length: 25 }, (_, index) => ({
      src: `data:image/jpeg;base64,${index}`
    })),
    resultShape: "memory-page"
  }), /memory_photos_exceed_limit/u);
  assert.equal((await store.listMemories(store.defaultCollectionId)).length, 0);
});

test('sync receipts are per-account and cannot advance a concurrent local edit or stale reopened copy',async()=>{
 const store=createMemoryRepository(createMemoryAdapter(),{currentYear:2026});await store.ensureDefaultCollection();
 const initial=await store.saveMemory({id:'sync',photos:[{id:'p',src:'data:image/jpeg;base64,one'}],answer:'local',syncBases:{}});
 const synced=await store.markMemorySynced(initial.id,'A',1,initial);assert.deepEqual(synced.syncBases,{A:1});
 const stale=structuredClone(synced);const newer=await store.saveMemory({...synced,answer:'new local'});
 assert.equal(await store.markMemorySynced(initial.id,'A',2,synced),null);assert.equal((await store.getMemory(initial.id)).answer,'new local');
 const next=await store.markMemorySynced(initial.id,'A',2,newer);assert.equal(next.syncBases.A,2);
 const oldTab=await store.saveMemory({...stale,answer:'older tab edit'});assert.equal(oldTab.syncBases.A,1);
 const other=await store.markMemorySynced(initial.id,'B',1,oldTab);assert.deepEqual(other.syncBases,{A:1,B:1});
});

test('explicit cloud import keeps remote ID and base while refusing an existing local copy',async()=>{
 const store=createMemoryRepository(createMemoryAdapter(),{currentYear:2026});await store.ensureDefaultCollection();
 const input={id:'memory:ordinary-uuid',photos:[{src:'data:image/jpeg;base64,one'}],answer:'remote original',syncBases:{A:3}};
 const first=await store.saveMemory(input,{createOnly:true});assert.equal(first.id,input.id);assert.equal(first.syncBases.A,3);
 await assert.rejects(store.saveMemory({...input,answer:'overwrite'},{createOnly:true}),/local_copy_exists/);
 assert.equal((await store.getMemory(input.id)).answer,'remote original');
});

function createMemoryAdapter() {
  let records = new Map(Object.values(MEMORY_STORE_NAMES).map((name) => [name, new Map()]));
  const keyFor = (storeName, value) => (
    storeName === MEMORY_STORE_NAMES.styleProfiles ? value.collectionId : value.id
  );
  return {
    async transaction(storeNames, mode, run) {
      const working = mode === "readwrite" ? structuredClone(records) : records;
      const stores = {
        async get(storeName, key) {
          return clone(working.get(storeName).get(key) ?? null);
        },
        async getAll(storeName) {
          return [...working.get(storeName).values()].map(clone);
        },
        async getAllByIndex(storeName, indexName, value) {
          const property = indexName === "by-collection" ? "collectionId" : "updatedAt";
          return [...working.get(storeName).values()]
            .filter((record) => record[property] === value)
            .map(clone);
        },
        async put(storeName, value) {
          working.get(storeName).set(keyFor(storeName, value), clone(value));
          return keyFor(storeName, value);
        },
        async delete(storeName, key) {
          working.get(storeName).delete(key);
        }
      };
      const result = await run(stores);
      if (mode === "readwrite") records = working;
      return result;
    },
    close() {}
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
