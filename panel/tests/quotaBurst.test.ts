/**
 * "Prioritise plan" bursts: API normalisation and calls, which rows offer
 * Prioritise, the row tag / Stop, and client-side expiry.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '@/i18n';
import {
  activeBursts,
  formatBurstEnd,
  nextBurstExpiry,
  rowBurstsByIndex,
  toForecastBursts,
} from '@/features/quota/quotaBurst';
import {
  canPrioritiseQuotaRow,
  canPrioritiseWeeklyQuotaRow,
  type QuotaLimitSummary,
} from '@/features/quota/quotaRowSummary';
import {
  QUOTA_BURST_PATH,
  apiClient,
  normalizeQuotaBurst,
  normalizeQuotaBurstList,
  quotaBurstApi,
  type QuotaBurst,
} from '@/services/api';
import { parseApiErrorResponse } from '@/services/api/apiError';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-28T12:00:00Z');

const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

// Other suites render in whatever language is current: put it back afterwards.
let previousLanguage = '';
beforeAll(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const burst = (overrides: Partial<QuotaBurst> = {}): QuotaBurst => ({
  authIndex: 'a',
  provider: 'claude',
  label: 'a@example.com',
  startedAtMs: NOW - HOUR,
  endsAtMs: NOW + HOUR,
  order: 1,
  kind: '5h',
  ...overrides,
});

describe('burst API normalisation', () => {
  test('reads the snake_case contract into epoch-ms fields', () => {
    expect(
      normalizeQuotaBurstList({
        bursts: [
          {
            auth_index: 'b1',
            provider: 'Codex',
            label: ' b@example.com ',
            started_at: '2026-10-28T11:00:00Z',
            ends_at: '2026-10-28T15:39:00Z',
            order: 2,
          },
          {
            auth_index: 7,
            provider: 'claude',
            label: 'a@example.com',
            started_at: '2026-10-28T10:00:00Z',
            ends_at: '2026-10-28T13:00:00Z',
            order: 1,
          },
        ],
      })
    ).toEqual([
      {
        authIndex: '7',
        provider: 'claude',
        label: 'a@example.com',
        startedAtMs: Date.parse('2026-10-28T10:00:00Z'),
        endsAtMs: Date.parse('2026-10-28T13:00:00Z'),
        order: 1,
        kind: '5h',
      },
      {
        authIndex: 'b1',
        provider: 'codex',
        label: 'b@example.com',
        startedAtMs: Date.parse('2026-10-28T11:00:00Z'),
        endsAtMs: Date.parse('2026-10-28T15:39:00Z'),
        order: 2,
        kind: '5h',
      },
    ]);
  });

  test('is defensive about missing and malformed fields', () => {
    // No auth index or no usable end: dropped rather than shown as a never-ending burst.
    expect(normalizeQuotaBurst({ ends_at: '2026-10-28T13:00:00Z' })).toBeNull();
    expect(normalizeQuotaBurst({ auth_index: 'a', ends_at: '0001-01-01T00:00:00Z' })).toBeNull();
    expect(normalizeQuotaBurst({ auth_index: 'a' })).toBeNull();
    expect(normalizeQuotaBurst('nope')).toBeNull();
    // Everything else degrades to an empty default; order falls back to list position.
    expect(normalizeQuotaBurst({ authIndex: 'a', endsAt: 1_800_000_000 }, 2)).toEqual({
      authIndex: 'a',
      provider: '',
      label: '',
      startedAtMs: null,
      endsAtMs: 1_800_000_000_000,
      order: 3,
      kind: '5h',
    });

    for (const payload of [null, undefined, '', {}, { bursts: null }, { bursts: {} }]) {
      expect(normalizeQuotaBurstList(payload)).toEqual([]);
    }
    // A bare array is accepted; order ties go to the sooner end; duplicates keep the first.
    const list = normalizeQuotaBurstList([
      { auth_index: 'x', ends_at: '2026-10-28T14:00:00Z', order: 'bad' },
      { auth_index: 'y', ends_at: '2026-10-28T13:00:00Z', order: 1 },
      { auth_index: 'y', ends_at: '2026-10-28T16:00:00Z', order: 5 },
      42,
    ]);
    expect(list.map((item) => [item.authIndex, item.order])).toEqual([
      ['y', 1],
      ['x', 1],
    ]);
  });

  test('list, prioritise and cancel use the shared client and the A3 contract', async () => {
    const payload = { bursts: [{ auth_index: 'a', ends_at: '2026-10-28T13:00:00Z', order: 1 }] };
    const get = spyOn(apiClient, 'get').mockResolvedValue(payload);
    const post = spyOn(apiClient, 'post').mockResolvedValue(payload);
    const del = spyOn(apiClient, 'delete').mockResolvedValue({ bursts: [] });
    mocks.push(get, post, del);

    expect(QUOTA_BURST_PATH).toBe('/quota/burst');
    expect((await quotaBurstApi.list()).map((item) => item.authIndex)).toEqual(['a']);
    expect(get).toHaveBeenCalledWith('/quota/burst');

    expect((await quotaBurstApi.prioritise('a'))[0].endsAtMs).toBe(
      Date.parse('2026-10-28T13:00:00Z')
    );
    expect(post).toHaveBeenCalledWith('/quota/burst', { auth_index: 'a' });

    expect(await quotaBurstApi.cancel('a')).toEqual([]);
    expect(del).toHaveBeenCalledWith('/quota/burst', { params: { auth_index: 'a' } });
  });

  test("a 409's `error` text is what the notification shows", () => {
    expect(
      parseApiErrorResponse({ error: 'no running 5-hour window' }, 'Request failed with 409')
        .message
    ).toBe('no running 5-hour window');
  });
});

describe('row eligibility', () => {
  const fiveHour = (overrides: Partial<QuotaLimitSummary> = {}): QuotaLimitSummary => ({
    id: 'five-hour',
    label: '5h',
    remaining: 60,
    resetAtMs: NOW + 2 * HOUR,
    periodHours: 5,
    primary: true,
    ...overrides,
  });
  const ok = { kind: 'ok' } as const;

  test('a running Claude / Codex 5-hour window with quota left can be prioritised', () => {
    expect(canPrioritiseQuotaRow('claude', ok, [fiveHour()], NOW)).toBeTrue();
    expect(canPrioritiseQuotaRow('codex', ok, [fiveHour({ remaining: 1 })], NOW)).toBeTrue();
    // A refresh in flight keeps the action in place.
    expect(canPrioritiseQuotaRow('codex', { kind: 'loading' }, [fiveHour()], NOW)).toBeTrue();
    // Full but with a fixed reset well inside the period: the window is running.
    expect(
      canPrioritiseQuotaRow(
        'claude',
        ok,
        [fiveHour({ remaining: 100, resetAtMs: NOW + HOUR })],
        NOW
      )
    ).toBeTrue();
  });

  test('other providers, unusable rows and windows not running are excluded', () => {
    expect(canPrioritiseQuotaRow('kimi', ok, [fiveHour()], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', { kind: 'disabled' }, [fiveHour()], NOW)).toBeFalse();
    expect(
      canPrioritiseQuotaRow(
        'claude',
        { kind: 'exhausted', backAtMs: NOW + HOUR },
        [fiveHour()],
        NOW
      )
    ).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', { kind: 'logged_out' }, [fiveHour()], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', { kind: 'idle' }, [], NOW)).toBeFalse();
    // No 5-hour window, no reset, a reset already passed, nothing left, unknown remaining.
    expect(canPrioritiseQuotaRow('claude', ok, [], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', ok, [fiveHour({ resetAtMs: null })], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', ok, [fiveHour({ resetAtMs: NOW })], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', ok, [fiveHour({ remaining: 0 })], NOW)).toBeFalse();
    expect(canPrioritiseQuotaRow('claude', ok, [fiveHour({ remaining: null })], NOW)).toBeFalse();
    // Unused Codex window: its reset slides a whole period ahead — not running yet.
    expect(
      canPrioritiseQuotaRow(
        'codex',
        ok,
        [fiveHour({ remaining: 100, resetAtMs: NOW + 5 * HOUR })],
        NOW
      )
    ).toBeFalse();
  });
});

describe('running bursts', () => {
  test('expired bursts disappear at ends_at; the rest keep routing order', () => {
    const list = [
      burst({ authIndex: 'late', order: 3, endsAtMs: NOW + 3 * HOUR }),
      burst({ authIndex: 'gone', order: 1, endsAtMs: NOW }),
      burst({ authIndex: 'next', order: 2, endsAtMs: NOW + HOUR }),
    ];
    expect(activeBursts(list, NOW - 1).map((item) => item.authIndex)).toEqual([
      'gone',
      'next',
      'late',
    ]);
    const active = activeBursts(list, NOW);
    expect(active.map((item) => item.authIndex)).toEqual(['next', 'late']);
    expect(nextBurstExpiry(active)).toBe(NOW + HOUR);
    expect(nextBurstExpiry([])).toBeNull();
  });

  test('tag ranks count per provider and fall back to the row provider', () => {
    const ranks = rowBurstsByIndex(
      [
        burst({ authIndex: 'c1', provider: 'claude', order: 1 }),
        burst({ authIndex: 'x1', provider: 'codex', order: 2 }),
        burst({ authIndex: 'c2', provider: '', order: 3 }),
        burst({ authIndex: 'x2', provider: 'codex', order: 4 }),
      ],
      (authIndex) => (authIndex === 'c2' ? 'claude' : '')
    );
    expect(Object.fromEntries([...ranks].map(([key, value]) => [key, value.rank]))).toEqual({
      c1: 1,
      x1: 1,
      c2: 2,
      x2: 2,
    });
  });

  test('forecast bursts are unix seconds in routing order', () => {
    expect(
      toForecastBursts([
        burst({ authIndex: 'a', endsAtMs: 1_800_000_000_999 }),
        burst({ authIndex: 'b', endsAtMs: 1_800_003_600_000 }),
      ])
    ).toEqual([
      { authIndex: 'a', endsAt: 1_800_000_000 },
      { authIndex: 'b', endsAt: 1_800_003_600 },
    ]);
  });

  test('the end time is a short clock time', () => {
    expect(formatBurstEnd(Date.parse('2026-10-28T15:39:00Z'), 'en-US', 'UTC')).toBe('3:39 PM');
    expect(formatBurstEnd(Date.parse('2026-10-28T15:39:00Z'), 'not a locale!', 'UTC')).toBe(
      '3:39 PM'
    );
  });
});

describe('row tag strings', () => {
  const KEYS = [
    'burst_prioritise',
    'burst_hint',
    'burst_tag',
    'burst_stop',
    'burst_stop_hint',
    'burst_failed',
    'burst_stop_failed',
    'burst_prioritise_weekly',
    'burst_hint_weekly',
    'burst_tag_weekly',
    'routing_burst',
    'routing_burst_weekly',
  ];
  const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];
  const tokens = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort().join('|');
  const read = (locale: string) =>
    JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
      .quota_management as Record<string, string>;

  test('the tag reads "Prioritised · #1 · ends 3:39 PM"', () => {
    const time = formatBurstEnd(Date.parse('2026-10-28T15:39:00Z'), 'en-US', 'UTC');
    expect(i18n.t('quota_management.burst_tag', { rank: 1, time })).toBe(
      'Prioritised · #1 · ends 3:39 PM'
    );
    expect(i18n.t('quota_management.burst_prioritise')).toBe('Prioritise');
    expect(i18n.t('quota_management.burst_stop')).toBe('Stop');
  });

  test('every locale carries every burst string with the same placeholders', () => {
    const english = read('en');
    for (const locale of LOCALES) {
      const messages = read(locale);
      for (const key of KEYS) {
        expect(`${locale}:${key}:${typeof messages[key]}`).toBe(`${locale}:${key}:string`);
        expect(`${locale}:${key}:${tokens(messages[key])}`).toBe(
          `${locale}:${key}:${tokens(english[key])}`
        );
      }
    }
  });

  test('the row wires the tag, Stop and Prioritise to those strings', () => {
    const row = readFileSync(
      new URL('../src/features/quota/components/QuotaAccountRow.tsx', import.meta.url),
      'utf8'
    );
    for (const key of [
      'burst_tag',
      'burst_stop',
      'burst_prioritise',
      'burst_hint',
      'burst_tag_weekly',
      'burst_prioritise_weekly',
      'burst_hint_weekly',
    ]) {
      expect(row).toContain(`'quota_management.${key}'`);
    }
    const hook = readFileSync(
      new URL('../src/features/quota/hooks/useQuotaBursts.ts', import.meta.url),
      'utf8'
    );
    expect(hook).toContain('POLL_MS = 60_000');
    expect(hook).toContain('usePolling(');
  });
});

describe('weekly bursts', () => {
  const limit = (id: string, overrides: Partial<QuotaLimitSummary> = {}): QuotaLimitSummary => ({
    id,
    label: id,
    remaining: 60,
    resetAtMs: NOW + 72 * HOUR,
    periodHours: 168,
    primary: true,
    ...overrides,
  });
  const ok = { kind: 'ok' } as const;

  test('the kind is read from the proxy and defaults to 5h', () => {
    expect(
      normalizeQuotaBurst({ auth_index: 'a', ends_at: '2026-10-31T12:00:00Z', kind: 'weekly' })
        ?.kind
    ).toBe('weekly');
    expect(normalizeQuotaBurst({ auth_index: 'a', ends_at: '2026-10-31T12:00:00Z' })?.kind).toBe(
      '5h'
    );
    expect(
      normalizeQuotaBurst({ auth_index: 'a', ends_at: '2026-10-31T12:00:00Z', kind: 'odd' })?.kind
    ).toBe('5h');
  });

  test('prioritising weekly sends kind; 5h keeps the original body', async () => {
    const payload = {
      bursts: [{ auth_index: 'a', ends_at: '2026-10-31T12:00:00Z', order: 1, kind: 'weekly' }],
    };
    const post = spyOn(apiClient, 'post').mockResolvedValue(payload);
    mocks.push(post);
    const list = await quotaBurstApi.prioritise('a', 'weekly');
    expect(post).toHaveBeenCalledWith('/quota/burst', { auth_index: 'a', kind: 'weekly' });
    expect(list[0].kind).toBe('weekly');
    await quotaBurstApi.prioritise('a');
    expect(post).toHaveBeenLastCalledWith('/quota/burst', { auth_index: 'a' });
  });

  test('row tags carry the kind', () => {
    const tags = rowBurstsByIndex([
      burst({ authIndex: 'w', kind: 'weekly' }),
      burst({ authIndex: 'f', order: 2 }),
    ]);
    expect(tags.get('w')?.kind).toBe('weekly');
    expect(tags.get('f')?.kind).toBe('5h');
  });

  test('a weekly end time includes the day', () => {
    expect(formatBurstEnd(Date.parse('2026-10-31T07:30:00Z'), 'en-US', 'UTC', true)).toBe(
      'Sat 7:30 AM'
    );
    expect(i18n.t('quota_management.burst_tag_weekly', { rank: 2, time: 'Sat 7:30 AM' })).toBe(
      'Prioritised weekly · #2 · ends Sat 7:30 AM'
    );
  });

  test('offered while weekly quota is left, also when only the 5-hour limit is used up', () => {
    expect(canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day')], NOW)).toBeTrue();
    expect(canPrioritiseWeeklyQuotaRow('codex', ok, [limit('weekly')], NOW)).toBeTrue();
    expect(
      canPrioritiseWeeklyQuotaRow(
        'claude',
        { kind: 'exhausted', backAtMs: NOW + HOUR },
        [limit('five-hour', { remaining: 0, resetAtMs: NOW + HOUR }), limit('seven-day')],
        NOW
      )
    ).toBeTrue();
  });

  test('not offered without a running weekly window with quota left', () => {
    expect(canPrioritiseWeeklyQuotaRow('kimi', ok, [limit('weekly')], NOW)).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', { kind: 'disabled' }, [limit('seven-day')], NOW)
    ).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', { kind: 'logged_out' }, [limit('seven-day')], NOW)
    ).toBeFalse();
    expect(canPrioritiseWeeklyQuotaRow('claude', ok, [], NOW)).toBeFalse();
    // A model-specific weekly limit does not count.
    expect(canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day-fable')], NOW)).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day', { remaining: 0 })], NOW)
    ).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day', { remaining: null })], NOW)
    ).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day', { resetAtMs: NOW })], NOW)
    ).toBeFalse();
    expect(
      canPrioritiseWeeklyQuotaRow('claude', ok, [limit('seven-day', { resetAtMs: null })], NOW)
    ).toBeFalse();
  });
});
