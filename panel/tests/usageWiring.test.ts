import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// CSS modules bind at import time and Bun cannot render them; keep the page wiring as
// small source contracts. Logic lives in model.ts / pricing.ts and is tested directly.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];

describe('usage page wiring', () => {
  test('route and observe-group nav item', () => {
    expect(read('src/router/MainRoutes.tsx')).toContain(
      "{ path: '/usage', element: <UsagePage /> }"
    );
    const layout = read('src/components/layout/MainLayout.tsx');
    const observe = layout.slice(layout.indexOf("id: 'observe'"), layout.indexOf("id: 'control'"));
    expect(observe).toContain("path: '/usage'");
    expect(observe).toContain("labelKey: 'nav.usage'");
    expect(observe).toContain("metaKey: 'nav_meta.usage'");
  });

  test('reads the v8 summary endpoint through the shared client', () => {
    const api = read('src/services/api/usage.ts');
    expect(api).toContain("USAGE_SUMMARY_PATH = '/usage/summary'");
    expect(api).toContain('apiClient.get');
    expect(api).toContain('tz_offset_minutes');
  });

  test('every locale carries every usage string with the same placeholders', () => {
    const tokens = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort().join('|');
    const english = JSON.parse(read('src/i18n/locales/en.json'));
    for (const locale of LOCALES) {
      const messages = JSON.parse(read(`src/i18n/locales/${locale}.json`));
      expect(typeof messages.nav.usage).toBe('string');
      expect(typeof messages.nav_meta.usage).toBe('string');
      expect(Object.keys(english.usage).filter((key) => !(key in messages.usage))).toEqual([]);
      for (const [key, value] of Object.entries<string>(english.usage)) {
        expect(`${locale}:${key}:${tokens(messages.usage[key] ?? '')}`).toBe(
          `${locale}:${key}:${tokens(value)}`
        );
      }
    }
  });

  test('account names never read the raw account field', () => {
    const model = read('src/features/usage/model.ts');
    expect(model).not.toMatch(/\.account\b|\['account'\]/);
  });
});
