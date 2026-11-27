/* 保存(このPCのブラウザ内 IndexedDB)。テスト用にメモリ保存も用意。 */
(function (RM) {
  'use strict';
  const STORES = {
    kv: { keyPath: 'k' },                       // 販売台帳・設定など
    layouts: { keyPath: 'id', autoIncrement: true },
    assignments: { keyPath: 'cust' },
    matches: { keyPath: 'id', autoIncrement: true },
    lines: { keyPath: 'id' },                   // 照合ごとの明細 {id, sales, receipt}
    confs: { keyPath: 'id' },                   // 照合ごとの確認状況 {id, items}
  };
  RM.STORE_NAMES = Object.keys(STORES);

  function req(r) { return new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); }); }

  class IdbStore {
    static async open(name = 'receipt-matcher') {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [n, o] of Object.entries(STORES)) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, o);
      };
      const s = new IdbStore();
      s.db = await req(r);
      return s;
    }
    tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
    get(store, key) { return req(this.tx(store, 'readonly').get(key)); }
    all(store) { return req(this.tx(store, 'readonly').getAll()); }
    put(store, value) { return req(this.tx(store, 'readwrite').put(value)); }
    del(store, key) { return req(this.tx(store, 'readwrite').delete(key)); }
    clear(store) { return req(this.tx(store, 'readwrite').clear()); }
    async estimate() { try { return await navigator.storage.estimate(); } catch (_) { return null; } }
  }

  class MemStore {
    constructor() { this.m = {}; this.seq = {}; for (const n of Object.keys(STORES)) { this.m[n] = new Map(); this.seq[n] = 0; } }
    static async open() { return new MemStore(); }
    clone(v) { return v === undefined ? v : structuredClone(v); }
    async get(store, key) { return this.clone(this.m[store].get(key)); }
    async all(store) { return [...this.m[store].values()].map(v => this.clone(v)); }
    async put(store, value) {
      const o = STORES[store];
      value = this.clone(value);
      if (o.autoIncrement && (value[o.keyPath] === undefined || value[o.keyPath] === null)) value[o.keyPath] = ++this.seq[store];
      else if (o.autoIncrement) this.seq[store] = Math.max(this.seq[store], value[o.keyPath]);
      this.m[store].set(value[o.keyPath], value);
      return value[o.keyPath];
    }
    async del(store, key) { this.m[store].delete(key); }
    async clear(store) { this.m[store].clear(); }
    async estimate() { return null; }
  }
  RM.IdbStore = IdbStore;
  RM.MemStore = MemStore;
})(globalThis.RM = globalThis.RM || {});
