/**
 * Quota page auto-refresh throttle, persisted view prefs, and page wiring.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { QUOTA_AUTO_REFRESH_MIN_INTERVAL_MS, shouldAutoRefreshQuota } from '@/features/quota/logic';
import {
  DEFAULT_QUOTA_VIEW_PREFS,
  readQuotaViewPrefs,
  writeQuotaViewPrefs,
} from '@/features/quota/uiState';
import { createConcurrencyLimiter } from '@/features/quota/hooks/useQuotaBatchLoader';

const KEY = 'quotaPage.viewPrefs';
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

describe('shouldAutoRefreshQuota', () => {
  test('refreshes when nothing has been loaded yet', () => {
    expect(shouldAutoRefreshQuota(null, 1_000)).toBe(true);
  });

  test('throttles refreshes inside the minimum interval', () => {
    expect(shouldAutoRefreshQuota(10_000, 10_000 + QUOTA_AUTO_REFRESH_MIN_INTERVAL_MS - 1)).toBe(
      false
    );
    expect(shouldAutoRefreshQuota(10_000, 10_000 + QUOTA_AUTO_REFRESH_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('quota view prefs', () => {
  test('defaults to a collapsed timeline and an open forecast', () => {
    expect(readQuotaViewPrefs()).toEqual({ timelineOpen: false, forecastOpen: true });
    expect(DEFAULT_QUOTA_VIEW_PREFS.timelineOpen).toBe(false);
  });

  test('persists the timeline and forecast states independently', () => {
    writeQuotaViewPrefs({ timelineOpen: true });
    expect(readQuotaViewPrefs()).toEqual({ timelineOpen: true, forecastOpen: true });
    writeQuotaViewPrefs({ forecastOpen: false });
    expect(readQuotaViewPrefs()).toEqual({ timelineOpen: true, forecastOpen: false });
  });

  test('ignores malformed stored values, including retired layout prefs', () => {
    storage.setItem(KEY, JSON.stringify({ layout: 'grid', timelineOpen: 'yes' }));
    expect(readQuotaViewPrefs()).toEqual(DEFAULT_QUOTA_VIEW_PREFS);
    storage.setItem(KEY, '{not json');
    expect(readQuotaViewPrefs()).toEqual(DEFAULT_QUOTA_VIEW_PREFS);
  });
});

describe('createConcurrencyLimiter', () => {
  test('never runs more than the limit at once and runs every task', async () => {
    const limited = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((value) =>
        limited(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return value * 10;
        })
      )
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  test('releases its slot when a task throws', async () => {
    const limited = createConcurrencyLimiter(1);
    await expect(limited(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limited(async () => 'next')).toBe('next');
  });
});

describe('quota page wiring', () => {
  const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');

  test('tab activation reloads only the local credential list', () => {
    expect(source).toContain("document.addEventListener('visibilitychange', listener)");
    expect(source).toContain("window.addEventListener('focus', listener)");
    expect(source).toContain("document.removeEventListener('visibilitychange', listener)");
    expect(source).toContain('shouldAutoRefreshQuota(lastListAtRef.current, Date.now())');
    const activation = source.slice(
      source.indexOf('const onPageActivated'),
      source.indexOf('useEffect(() => {', source.indexOf('const onPageActivated'))
    );
    expect(activation).toContain('void loadFiles();');
    expect(activation).not.toContain('loadQuota');
    expect(activation).not.toContain('handleRefreshAll');
  });

  test('never queues an upstream quota fetch on mount or connect', () => {
    // Upstream usage endpoints are only hit from explicit refresh actions.
    expect(source).not.toMatch(
      /if \(connectionStatus !== 'connected'\) return;\s*pendingRefreshRef\.current = sessionGeneration;/
    );
    expect(source).toContain('readPassiveQuota(entry.type, entry.file)');
  });

  test('has no filtering, sorting, or layout controls', () => {
    expect(source).not.toContain('<ProviderTabs');
    expect(source).not.toContain('type="search"');
    expect(source).not.toContain('<Select');
  });
});
