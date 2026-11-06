/**
 * Quota page "tidied list": the compact reset line ("23:50 · 4h"), the limit
 * column count shared by a provider group's rows, the in-use routing chip and
 * the prioritised pill.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaRoutingOrder } from '@/features/quota/components/QuotaRoutingOrder';
import { formatBurstEndShort } from '@/features/quota/quotaBurst';
import { limitColumnCount } from '@/features/quota/quotaRowSummary';
import type { RoutingStep } from '@/features/quota/routingOrder';
import {
  buildCompactResetDisplay,
  formatCompactInstant,
  formatCompactRelative,
} from '@/utils/quota';

const UTC = 'UTC';
// Friday 6 November 2026, 15:50 UTC.
const NOW = Date.UTC(2026, 10, 6, 15, 50);

let previousLanguage = 'en';
beforeAll(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe('compact reset line', () => {
  test('today shows the time alone', () => {
    expect(formatCompactInstant(Date.UTC(2026, 10, 6, 23, 50), NOW, 'en', UTC)).toBe('23:50');
  });

  test('other days within a week add the weekday', () => {
    expect(formatCompactInstant(Date.UTC(2026, 10, 12, 6, 30), NOW, 'en', UTC)).toBe('Thu 06:30');
    // Tomorrow, even if under 24 hours away.
    expect(formatCompactInstant(Date.UTC(2026, 10, 7, 0, 0), NOW, 'en', UTC)).toBe('Sat 00:00');
  });

  test('a week or more away uses the date, since a weekday would be ambiguous', () => {
    expect(formatCompactInstant(Date.UTC(2026, 10, 26, 6, 30), NOW, 'en', UTC)).toBe(
      'Nov 26 06:30'
    );
  });

  test('the countdown is narrow and truncated', () => {
    expect(formatCompactRelative(NOW + 4 * 3_600_000 + 59 * 60_000, NOW, 'en')).toBe('4h');
    expect(formatCompactRelative(Date.UTC(2026, 10, 12, 6, 30), NOW, 'en')).toBe('5d');
    expect(formatCompactRelative(NOW + 12 * 60_000, NOW, 'en')).toBe('12m');
    expect(formatCompactRelative(NOW - 4 * 60_000, NOW, 'en')).toContain('ago');
  });

  test('builds "23:50 · 8h" with the full wording kept for the tooltip', () => {
    const at = Date.UTC(2026, 10, 6, 23, 50);
    const display = buildCompactResetDisplay('11-06 23:50', at, NOW, 'en', UTC);
    expect(display).toEqual({
      when: '23:50',
      relative: '8h',
      full: '11-06 23:50 · in 8 hours',
    });
    expect(i18n.t('quota_management.limit_reset_title', { time: display?.full })).toBe(
      'Resets 11-06 23:50 · in 8 hours'
    );
  });

  test('without an instant it falls back to the provider label alone', () => {
    expect(buildCompactResetDisplay('11-06 23:50', null, NOW, 'en', UTC)).toEqual({
      when: '11-06 23:50',
      relative: null,
      full: '11-06 23:50',
    });
    expect(buildCompactResetDisplay(undefined, null, NOW, 'en', UTC)).toBeNull();
  });

  test('stays localised', () => {
    expect(formatCompactInstant(Date.UTC(2026, 10, 12, 6, 30), NOW, 'zh-CN', UTC)).toBe(
      '周四 06:30'
    );
    expect(formatCompactRelative(Date.UTC(2026, 10, 12, 6, 30), NOW, 'zh-CN')).toBe('5天');
  });
});

describe('limitColumnCount', () => {
  test("is the group's widest row, so limits line up across rows", () => {
    expect(limitColumnCount([3, 2, 3, 3])).toBe(3);
    expect(limitColumnCount([2])).toBe(2);
  });

  test('is capped at three and never below two', () => {
    expect(limitColumnCount([6, 1])).toBe(3);
    expect(limitColumnCount([])).toBe(2);
    expect(limitColumnCount([1])).toBe(2);
  });
});

describe('routing chips', () => {
  const step = (name: string, extra: Partial<RoutingStep> = {}): RoutingStep => ({
    authIndex: name,
    name,
    priority: 0,
    burst: null,
    ready: true,
    inUse: false,
    ...extra,
  });

  const render = (steps: RoutingStep[]) =>
    renderToStaticMarkup(createElement(QuotaRoutingOrder, { steps, now: NOW }));

  test('the in-use chip has no visible "in use" word but keeps it for titles and readers', () => {
    const markup = render([
      step('admin@example.com', { priority: 84, inUse: true }),
      step('dev@example.com', { priority: 80, ready: false }),
    ]);
    expect(i18n.t('quota_management.routing_in_use_hint')).toBe('Receiving new requests now');
    expect(markup).toContain('title="admin@example.com · Receiving new requests now"');
    expect(markup).toContain('title="dev@example.com · unavailable"');
    // "in use" / "unavailable" survive only as visually hidden text.
    expect(markup.match(/>in use</g)).toHaveLength(1);
    expect(markup.match(/>unavailable</g)).toHaveLength(1);
    expect(markup).toContain('>P84<');
  });

  test('every round-robin chip in use gets the treatment', () => {
    const markup = render([
      step('a', { priority: 50, inUse: true }),
      step('b', { priority: 50, inUse: true }),
      step('c', { priority: 10 }),
    ]);
    expect(markup.match(/Receiving new requests now/g)).toHaveLength(2);
  });

  test('prioritised chips show "#1 · time", weekly ones add the ⇈ mark', () => {
    const endsAtMs = Date.UTC(2026, 10, 6, 23, 30);
    const markup = render([
      step('code', { inUse: true, burst: { rank: 1, endsAtMs, kind: '5h' } }),
      step('rishit', { burst: { rank: 2, endsAtMs, kind: 'weekly' } }),
    ]);
    expect(markup).toMatch(/>#1 · [^<]+</);
    expect(markup).toMatch(/>#2 · [^<]+</);
    expect(markup).toContain('Prioritised #1 · until');
    expect(markup).toContain('Prioritised weekly #2 · until');
    expect(markup.match(/<svg/g)).toHaveLength(1);
  });
});

describe('formatBurstEndShort', () => {
  test('5-hour keeps the clock time, weekly uses the 24-hour weekday form', () => {
    const endsAtMs = Date.UTC(2026, 10, 6, 23, 30);
    expect(formatBurstEndShort({ kind: '5h', endsAtMs }, NOW, 'en-US', UTC)).toBe('11:30 PM');
    expect(
      formatBurstEndShort(
        { kind: 'weekly', endsAtMs: Date.UTC(2026, 10, 7, 7, 30) },
        NOW,
        'en-US',
        UTC
      )
    ).toBe('Sat 07:30');
  });
});

describe('row grid contract', () => {
  const css = readFileSync(
    new URL('../src/features/quota/components/QuotaAccountRow.module.scss', import.meta.url),
    'utf8'
  );
  const group = readFileSync(
    new URL('../src/features/quota/components/QuotaProviderGroup.module.scss', import.meta.url),
    'utf8'
  );

  test('tracks never size from row content, so limits start at the same x in every row', () => {
    const row = css.slice(css.indexOf('.row {'), css.indexOf('}', css.indexOf('.row {')));
    const columns = row.slice(row.indexOf('grid-template-columns'));
    expect(columns).not.toMatch(/\bauto\b|max-content|min-content|fit-content/);
    expect(columns).toContain('var(--quota-status-width)');
    expect(css).toContain(
      'grid-template-columns: repeat(var(--quota-limit-columns, 3), minmax(0, 1fr));'
    );
  });

  test('the group is the size container every row switches layout on together', () => {
    expect(group).toContain('container-type: inline-size;');
    expect(css).toContain('@container (width < 772px)');
  });
});

describe('prioritised pill contract', () => {
  const row = readFileSync(
    new URL('../src/features/quota/components/QuotaAccountRow.tsx', import.meta.url),
    'utf8'
  );

  test('stops from an × inside the pill instead of a wide Stop button', () => {
    const pill = row.slice(row.indexOf('styles.burstPill'), row.indexOf('{statusText ? null'));
    expect(pill).toContain("'quota_management.burst_short'");
    expect(pill).toContain('<IconX');
    expect(pill).toContain("aria-label={t('quota_management.burst_stop')}");
    expect(pill).toContain("title={t('quota_management.burst_stop_hint')}");
    expect(pill).toContain('<IconChevronsUp');
    expect(pill).not.toContain('styles.rowAction}');
  });

  test('every locale carries the new strings with matching placeholders', () => {
    const tokens = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort().join('|');
    const read = (locale: string) =>
      JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ).quota_management as Record<string, string>;
    const english = read('en');
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi']) {
      const messages = read(locale);
      for (const key of ['routing_in_use_hint', 'burst_short', 'limit_reset_title']) {
        expect(`${locale}:${key}:${typeof messages[key]}`).toBe(`${locale}:${key}:string`);
        expect(tokens(messages[key])).toBe(tokens(english[key]));
      }
    }
  });
});
