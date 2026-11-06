/**
 * Source contracts for the proxy-owned Claude / Codex quota: no code path may
 * call their usage endpoints through `api-call`, refreshes are batched, every
 * screen hydrates from the proxy's snapshots, and the forecast is wired in.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const SOURCES = sourceFiles(join(ROOT, 'src')).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

const FORBIDDEN_CONSTANTS = [
  'CLAUDE_USAGE_URL',
  'CLAUDE_PROFILE_URL',
  'CODEX_USAGE_URL',
  'CODEX_SUBSCRIPTION_URL',
  'CODEX_RATE_LIMIT_RESET_CREDITS_URL',
];

/** The literal upstream URLs, so a copy-pasted string cannot sneak around the constants. */
const FORBIDDEN_URLS = [
  /api\.anthropic\.com\/api\/oauth\/usage/,
  /api\.anthropic\.com\/api\/oauth\/profile/,
  /chatgpt\.com\/backend-api\/wham\/usage/,
  /chatgpt\.com\/backend-api\/subscriptions/,
  // The consume action (`…/consume`) stays a direct api-call; the read does not.
  /chatgpt\.com\/backend-api\/wham\/rate-limit-reset-credits(?!\/consume)/,
];

const DEFINITIONS = 'src/utils/quota/constants.ts';

describe('no direct upstream quota reads', () => {
  test('nothing outside the constants module references the read-endpoint constants', () => {
    const offenders = SOURCES.filter(({ path }) => path !== DEFINITIONS).flatMap(({ path, text }) =>
      FORBIDDEN_CONSTANTS.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map(
        (name) => `${path}: ${name}`
      )
    );
    expect(offenders).toEqual([]);
  });

  test('no file that calls apiCallApi carries a read-endpoint URL', () => {
    const offenders = SOURCES.filter(({ text }) => /\bapiCallApi\b/.test(text)).flatMap(
      ({ path, text }) =>
        FORBIDDEN_URLS.filter((pattern) => pattern.test(text)).map(
          (pattern) => `${path}: ${pattern.source}`
        )
    );
    expect(offenders).toEqual([]);
  });

  test('the URLs live only in the constants module', () => {
    const offenders = SOURCES.filter(({ path }) => path !== DEFINITIONS).flatMap(({ path, text }) =>
      FORBIDDEN_URLS.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${path}: ${pattern.source}`
      )
    );
    expect(offenders).toEqual([]);
  });

  test('the Claude and Codex adapters read through the proxy refresh', () => {
    for (const path of [
      'src/features/quota/providers/claude/data.ts',
      'src/features/quota/providers/codex/data.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('refreshSnapshotFor(');
      expect(source).toContain('fromSnapshot:');
    }
    // Only the reset-credit consume action remains a direct api-call.
    const codex = read('src/features/quota/providers/codex/data.ts');
    expect(codex.match(/apiCallApi\.request\(/g)).toHaveLength(1);
    expect(codex).toContain('url: CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL');
    expect(codex).toContain('refreshSnapshotFor(authIndex, { force: true })');
    expect(read('src/features/quota/providers/claude/data.ts')).not.toContain('apiCallApi');
  });
});

describe('shared quota source wiring', () => {
  test('batch refresh sends Claude / Codex as one proxy request', () => {
    const loader = read('src/features/quota/hooks/useQuotaBatchLoader.ts');
    expect(loader).toContain('refreshProxyQuotaEntries(proxyEntries, t)');
    expect(loader).toContain('isProxyQuotaType(type)');
  });

  test('the quota page and auth files page hydrate from proxy snapshots', () => {
    const page = read('src/features/quota/QuotaPage.tsx');
    expect(page).toContain('useProxyQuotaHydration(files, listSettled && !disableControls)');
    // localStorage persistence covers the other providers only.
    expect(page).toContain('PERSISTED_QUOTA_TYPES.forEach((type) => {');
    expect(page).not.toMatch(
      /QUOTA_TAB_ORDER\.forEach\(\(type\) => \{\s*const saved = readSavedQuota/
    );
    const authFiles = read('src/features/authFiles/AuthFilesPage.tsx');
    expect(authFiles).toContain('useProxyQuotaHydration(files,');
  });

  test('the forecast sits above the provider groups', () => {
    const page = read('src/features/quota/QuotaPage.tsx');
    const forecast = page.indexOf('<QuotaForecast');
    expect(forecast).toBeGreaterThan(-1);
    expect(forecast).toBeLessThan(page.indexOf('<QuotaProviderGroup'));
  });

  test('history is read through the shared management client and polled every 60 s', () => {
    const api = read('src/services/api/quotaSnapshots.ts');
    expect(api).toContain("QUOTA_HISTORY_PATH = '/quota/history'");
    expect(api).toContain("QUOTA_SNAPSHOTS_PATH = '/quota/snapshots'");
    expect(api).toContain("QUOTA_REFRESH_PATH = '/quota/refresh'");
    expect(api).toContain('apiClient.get');
    expect(api).toContain('apiClient.post');
    const hook = read('src/features/quota/hooks/useQuotaHistory.ts');
    expect(hook).toContain('POLL_MS = 60_000');
    expect(hook).toContain('usePolling(');
  });
});

describe('forecast locales', () => {
  const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];
  const tokens = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort().join('|');

  test('every locale carries every forecast string with the same placeholders', () => {
    const english = JSON.parse(read('src/i18n/locales/en.json')).quota_forecast;
    for (const locale of LOCALES) {
      const messages = JSON.parse(read(`src/i18n/locales/${locale}.json`)).quota_forecast ?? {};
      expect(Object.keys(english).filter((key) => !(key in messages))).toEqual([]);
      for (const [key, value] of Object.entries<string>(english)) {
        expect(`${locale}:${key}:${tokens(messages[key] ?? '')}`).toBe(
          `${locale}:${key}:${tokens(value)}`
        );
      }
    }
  });

  test('every forecast key used in source exists in English', () => {
    const english = JSON.parse(read('src/i18n/locales/en.json')).quota_forecast;
    const used = new Set(
      SOURCES.filter(({ path }) => path.startsWith('src/features/quota/')).flatMap(({ text }) =>
        Array.from(text.matchAll(/'quota_forecast\.([a-z0-9_]+)'/g), (match) => match[1])
      )
    );
    expect(Array.from(used).filter((key) => !(key in english))).toEqual([]);
  });
});
