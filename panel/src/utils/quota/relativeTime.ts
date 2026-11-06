/**
 * Relative time beside absolute time.
 *
 * A quota card used to say `08-13 14:30` and leave the arithmetic to the
 * reader. The absolute instant is what you need to plan around; the relative
 * one ("in 11 days") is what you need to *react* to. Showing both costs one
 * short span and removes the mental subtraction, so every date on a card now
 * carries its own countdown.
 *
 * Pure and clock-free — `nowMs` is always passed in, so every case is directly
 * testable and the caller decides how often it ticks (see `useNow`).
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export interface RelativeTimeParts {
  /** Signed magnitude: positive is future, negative is past. */
  value: number;
  unit: 'day' | 'hour' | 'minute';
}

/**
 * Coarsest unit that still describes the gap, with a signed magnitude.
 *
 * Signed on purpose: the earlier timeline-local version clamped with
 * `Math.max(0, …)`, so a credit that expired last week read "in 1 minute" —
 * technically monotonic, actively misleading.
 *
 * Truncated, not rounded up, for two reasons. It is the ordinary countdown
 * convention ("2 hours left" holds from 2:59 down to 2:00), and rounding up
 * crosses the unit thresholds: `DAY_MS - 1` picks the hour unit and then
 * ceils to "24 hours", `HOUR_MS - 1` to "60 minutes". For a deadline it also
 * errs in the safe direction — never claiming more time than remains.
 *
 * Sub-minute gaps floor to a magnitude of 1 so nothing renders "in 0 minutes".
 */
export function relativeTimeParts(targetMs: number, nowMs: number): RelativeTimeParts {
  const delta = targetMs - nowMs;
  const sign = delta < 0 ? -1 : 1;
  const abs = Math.abs(delta);

  if (abs >= DAY_MS) return { value: sign * Math.floor(abs / DAY_MS), unit: 'day' };
  if (abs >= HOUR_MS) return { value: sign * Math.floor(abs / HOUR_MS), unit: 'hour' };
  return { value: sign * Math.max(1, Math.floor(abs / MINUTE_MS)), unit: 'minute' };
}

/**
 * Formatters are cached per locale: this runs once per quota row per minute,
 * and constructing an Intl formatter is the expensive part.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeFormatter(locale?: string): Intl.RelativeTimeFormat {
  const key = locale ?? '';
  const cached = relativeFormatters.get(key);
  if (cached) return cached;

  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  } catch {
    // An unexpected `resolvedLanguage` throws RangeError rather than falling
    // back on its own. A countdown in the wrong language beats no card at all.
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  }
  relativeFormatters.set(key, formatter);
  return formatter;
}

/** Localized relative phrase, e.g. `in 11 days` / `11 天后` / `11 days ago`. */
export function formatRelativeInstant(targetMs: number, nowMs: number, locale?: string): string {
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  return getRelativeFormatter(locale).format(value, unit);
}

/**
 * Absolute instant in the shape every quota row already uses (`MM-DD HH:mm`,
 * browser-local, 24-hour). Kept in one place so the reset labels baked at fetch
 * time and the ones formatted at render time can never drift apart.
 */
export function formatInstantShort(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export interface ResetDisplay {
  absolute: string;
  /** Null when no usable instant was available — render the absolute half alone. */
  relative: string | null;
}

/**
 * Pair an already-formatted absolute label with a freshly computed relative one.
 *
 * The absolute label wins when present because providers bake it at fetch time
 * and some of them cannot be reproduced at render (`formatCodexResetLabel`
 * resolves `reset_after_seconds` against the fetch-time clock). The instant is
 * only used for the relative half, and its absence degrades to exactly the
 * pre-existing rendering — which is what a store entry cached by an older
 * build, with no `resetAtMs` field, will hit.
 *
 * Returns null when there is nothing worth rendering at all.
 */
export function buildResetDisplay(
  absoluteLabel: string | undefined | null,
  atMs: number | undefined | null,
  nowMs: number,
  locale?: string
): ResetDisplay | null {
  const trimmed = typeof absoluteLabel === 'string' ? absoluteLabel.trim() : '';
  const absolute = trimmed && trimmed !== '-' ? trimmed : null;
  const usableMs = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : null;

  if (absolute === null && usableMs === null) return null;

  return {
    absolute: absolute ?? formatInstantShort(usableMs as number),
    relative: usableMs === null ? null : formatRelativeInstant(usableMs, nowMs, locale),
  };
}

export interface CompactResetDisplay {
  /**
   * When the window resets, as short as stays unambiguous: `23:50` today,
   * `Thu 06:30` within a week, `Nov 26 06:30` further out. The provider's own
   * label when no instant is known.
   */
  when: string;
  /** Narrow countdown (`4h`, `5d`, `12m`); null when no instant is known. */
  relative: string | null;
  /** Long form for a tooltip: the `buildResetDisplay` pair, e.g. `06/11, 23:50 · in 4 hours`. */
  full: string;
}

const compactFormatters = new Map<string, unknown>();

function cachedFormatter<T>(key: string, create: (locale?: string) => T, locale?: string): T {
  const cacheKey = `${key}|${locale ?? ''}`;
  const cached = compactFormatters.get(cacheKey);
  if (cached) return cached as T;
  let formatter: T;
  try {
    formatter = create(locale);
  } catch {
    formatter = create(undefined);
  }
  compactFormatters.set(cacheKey, formatter);
  return formatter;
}

const dateTimeFormatter = (
  kind: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
  timeZone?: string
) =>
  cachedFormatter(
    `${kind}|${timeZone ?? ''}`,
    (resolved) => new Intl.DateTimeFormat(resolved, { ...options, timeZone }),
    locale
  );

/** `23:50`, `Thu 06:30` or `Nov 26 06:30` — 24-hour, like the reset labels the providers bake. */
export function formatCompactInstant(
  targetMs: number,
  nowMs: number,
  locale?: string,
  timeZone?: string
): string {
  const time = dateTimeFormatter(
    'time',
    { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    locale,
    timeZone
  ).format(targetMs);
  const dayKey = dateTimeFormatter(
    'day',
    { year: 'numeric', month: '2-digit', day: '2-digit' },
    'en-CA',
    timeZone
  );
  if (dayKey.format(targetMs) === dayKey.format(nowMs)) return time;
  const day =
    Math.abs(targetMs - nowMs) < 7 * DAY_MS
      ? dateTimeFormatter('weekday', { weekday: 'short' }, locale, timeZone).format(targetMs)
      : dateTimeFormatter('date', { month: 'short', day: 'numeric' }, locale, timeZone).format(
          targetMs
        );
  return `${day} ${time}`;
}

/** `4h`, `5d`, `12m` — the countdown without "in"; past instants keep their "ago". */
export function formatCompactRelative(targetMs: number, nowMs: number, locale?: string): string {
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  if (value < 0) {
    return cachedFormatter(
      'relative-short',
      (resolved) => new Intl.RelativeTimeFormat(resolved, { style: 'short' }),
      locale
    ).format(value, unit);
  }
  return cachedFormatter(
    `unit-${unit}`,
    (resolved) => new Intl.NumberFormat(resolved, { style: 'unit', unit, unitDisplay: 'narrow' }),
    locale
  ).format(value);
}

/**
 * The compact reset line of a quota row (`23:50 · 4h`), plus the full wording
 * for its tooltip. Null when there is nothing worth rendering, like
 * `buildResetDisplay`.
 */
export function buildCompactResetDisplay(
  absoluteLabel: string | undefined | null,
  atMs: number | undefined | null,
  nowMs: number,
  locale?: string,
  timeZone?: string
): CompactResetDisplay | null {
  const display = buildResetDisplay(absoluteLabel, atMs, nowMs, locale);
  if (!display) return null;
  const full = display.relative ? `${display.absolute} · ${display.relative}` : display.absolute;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return { when: display.absolute, relative: null, full };
  }
  return {
    when: formatCompactInstant(atMs, nowMs, locale, timeZone),
    relative: formatCompactRelative(atMs, nowMs, locale),
    full,
  };
}
