/**
 * Saved quota: explicit fetches survive reloads so the rows and the reset
 * timeline don't need another rate-limited upstream call.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readSavedQuota, syncSavedQuota } from '@/features/quota/quotaPersistence';

const KEY = 'quotaPage.savedQuota.v1';
const BASE = 'http://127.0.0.1:8317';
const originalWindow = (globalThis as { window?: unknown }).window;

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  return storage;
}

let storage: ReturnType<typeof installLocalStorage>;

beforeEach(() => {
  storage = installLocalStorage();
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

const success = (usedPercent: number) => ({
  status: 'success',
  windows: [{ id: 'weekly', usedPercent, resetAtMs: 1, periodHours: 168 }],
});

describe('quota persistence', () => {
  test('saves success states and reads them back', () => {
    syncSavedQuota(BASE, { codex: { a: success(40) } }, { codex: new Set(['a']) }, 1000);
    const saved = readSavedQuota(BASE, 'codex');
    expect(saved.a.state).toEqual(success(40));
    expect(saved.a.savedAtMs).toBe(1000);
  });

  test('a failed or loading refresh never erases a saved success', () => {
    syncSavedQuota(BASE, { claude: { a: success(10) } }, { claude: new Set(['a']) }, 1000);
    syncSavedQuota(
      BASE,
      { claude: { a: { status: 'error', errorStatus: 429 } } },
      { claude: new Set(['a']) },
      2000
    );
    syncSavedQuota(
      BASE,
      { claude: { a: { status: 'loading' } } },
      { claude: new Set(['a']) },
      3000
    );
    expect(readSavedQuota(BASE, 'claude').a.state).toEqual(success(10));
  });

  test('a newer success replaces the old one; an identical one keeps its timestamp', () => {
    syncSavedQuota(BASE, { codex: { a: success(40) } }, { codex: new Set(['a']) }, 1000);
    expect(
      syncSavedQuota(BASE, { codex: { a: success(40) } }, { codex: new Set(['a']) }, 2000)
    ).toBe(false);
    expect(readSavedQuota(BASE, 'codex').a.savedAtMs).toBe(1000);
    syncSavedQuota(BASE, { codex: { a: success(70) } }, { codex: new Set(['a']) }, 3000);
    expect(readSavedQuota(BASE, 'codex').a).toEqual({ state: success(70), savedAtMs: 3000 });
  });

  test('credentials that no longer exist are dropped', () => {
    syncSavedQuota(
      BASE,
      { codex: { a: success(1), b: success(2) } },
      { codex: new Set(['a', 'b']) },
      1000
    );
    syncSavedQuota(BASE, { codex: {} }, { codex: new Set(['a']) }, 2000);
    expect(Object.keys(readSavedQuota(BASE, 'codex'))).toEqual(['a']);
  });

  test('is scoped to the API base and tolerates corrupt storage', () => {
    syncSavedQuota(BASE, { codex: { a: success(1) } }, { codex: new Set(['a']) }, 1000);
    expect(readSavedQuota('http://other:8317', 'codex')).toEqual({});
    storage.setItem(KEY, '{not json');
    expect(readSavedQuota(BASE, 'codex')).toEqual({});
  });
});

describe('quota page wiring', () => {
  const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');

  test('hydrates from and syncs to saved quota once the list has settled', () => {
    expect(source).toContain('readSavedQuota(apiBase, type)');
    expect(source).toContain('syncSavedQuota(apiBase, quotaByType, survivors, Date.now())');
  });

  test('the timeline draws the merged live + fetched data, not only fetched state', () => {
    expect(source).toContain('quotaFor={getTimelineQuota}');
  });
});
