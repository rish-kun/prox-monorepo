import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { RoutingSettingsGroup } from '@/features/routing/components/RoutingSettingsGroup';
import { RoutingPoolGroup } from '@/features/routing/components/RoutingPoolGroup';
import type { CredentialRowHandlers } from '@/features/routing/components/RoutingCredentialRow';
import {
  groupIntoTiers,
  readRoutingSettings,
  type RoutingCredential,
} from '@/features/routing/logic';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];
const ROUTING_DIR = 'src/features/routing';
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)]
  );
const read = (path: string) => readFileSync(path, 'utf8');

const noop = () => {};
const handlers: CredentialRowHandlers = {
  onToggleExpand: noop,
  onPriority: noop,
  onWeight: noop,
  onExcluded: noop,
  onRetryExcluded: noop,
  onEnable: noop,
  onResetCooldown: noop,
};

const now = Date.now();
const credentials: RoutingCredential[] = [
  {
    key: 'pro.json',
    name: 'pro.json',
    provider: 'codex',
    label: 'pro@example.test',
    authIndex: '1',
    disabled: false,
    editable: true,
    priority: 20,
    weight: 3,
    planType: 'pro',
  },
  {
    key: 'free.json',
    name: 'free.json',
    provider: 'codex',
    label: 'free@example.test',
    authIndex: '2',
    disabled: false,
    editable: true,
    priority: 0,
    planType: 'free',
    cooldown: {
      receivedAtMs: now,
      records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 120 }],
    },
  },
];

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('routing page rendering', () => {
  test('policy group renders labelled controls and the sticky note only on demand', () => {
    const settings = readRoutingSettings({ strategy: 'weighted-round-robin' });
    const render = (stickyNote: boolean) =>
      renderToStaticMarkup(
        createElement(RoutingSettingsGroup, {
          settings,
          errors: { sessionAffinityTTL: 'duration' },
          disabled: false,
          stickyNote,
          onChange: noop,
        })
      );
    const html = render(false);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="weighted-round-robin"/);
    expect(html).toContain('Fill first');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Use a duration like 30m or 1h');
    expect(html).not.toContain('may reset active sticky sessions');
    expect(render(true)).toContain('Changing this may reset active sticky sessions');
    // Every input has an associated label.
    const ids = [...html.matchAll(/<input id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(5);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
  });

  test('pool group renders tiers, plan chips, state, weights and the preset menu', () => {
    const render = (weighted: boolean, drafts = {}) =>
      renderToStaticMarkup(
        createElement(RoutingPoolGroup, {
          provider: 'codex',
          credentials,
          tiers: groupIntoTiers(credentials, drafts),
          drafts,
          errors: {},
          weighted,
          nowMs: now,
          resolvedTheme: 'light',
          disabled: false,
          expanded: new Set(['pro.json']),
          excluded: { 'pro.json': { status: 'loading' } },
          busyKeys: new Set(),
          handlers,
          onPreset: noop,
        })
      );
    const html = render(false);
    expect(html).toContain('pro@example.test');
    expect(html).toContain('Pro 200');
    expect(html).toContain('P20');
    expect(html).toContain('Serving');
    expect(html).toContain('Fallback');
    expect(html).toContain('Cooling · 2m');
    expect(html).toContain('Clear cooldown for free@example.test');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('Reading credential file');
    expect(html).toContain('aria-label="Route requests to pro@example.test"');
    expect(html).not.toContain('Weight for pro@example.test');
    expect(render(true)).toContain('Weight for pro@example.test');
    // Draft priorities regroup rows into a single tier.
    expect(render(false, { 'free.json': { priority: '20' } })).not.toContain('Fallback');
  });
});

describe('routing page contracts', () => {
  test('every routing.* key used in source exists in all six locales', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(ROUTING_DIR).filter((path) => /\.tsx?$/.test(path))) {
      for (const match of read(file).matchAll(/['`]routing\.([a-z_]+)(?:_\$\{[^}]+\})?['`]/g)) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(40);
    for (const locale of LOCALES) {
      const routing = JSON.parse(read(`src/i18n/locales/${locale}.json`)).routing as Record<
        string,
        string
      >;
      const keys = Object.keys(routing);
      for (const key of used) {
        const present = key in routing || keys.some((candidate) => candidate.startsWith(`${key}_`));
        expect(`${locale}:${key}:${present}`).toBe(`${locale}:${key}:true`);
      }
      expect(keys.sort()).toEqual(
        Object.keys(JSON.parse(read('src/i18n/locales/en.json')).routing).sort()
      );
    }
  });

  test('page saves through the floating bar, credential fields and refreshes caches', () => {
    const page = read(`${ROUTING_DIR}/RoutingPage.tsx`);
    expect(page).toContain('<FloatingSaveBar');
    expect(page).toContain('authFilesApi.patchFields(');
    expect(page).toContain('routingApi.patchRouting(');
    expect(page).toContain('routingApi.patchUpstreamCooling(');
    expect(page).toContain('fetchConfig(true)');
    expect(page).toContain('notifyAuthFilesChanged()');
    expect(page).toContain('authFilesApi.setStatus(');
    expect(page).toContain('authFilesApi.resetCooldown(');
    expect(page).toContain('authFilesApi.downloadText(');
    // Guard mounts only while dirty: an always-on blocker drops back/forward navigation.
    expect(page).toContain('dirty && <UnsavedChangesGuard');
    expect(page).toContain('stickyResetRisk(');
  });

  test('styles stay on theme tokens with small radii and reduced-motion handling', () => {
    const scss = read(`${ROUTING_DIR}/components/Routing.module.scss`);
    expect(scss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(scss).not.toMatch(/box-shadow/);
    for (const match of scss.matchAll(/border-radius:\s*(\d+)px/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(6);
    }
    expect(scss).toContain('prefers-reduced-motion');
  });
});
