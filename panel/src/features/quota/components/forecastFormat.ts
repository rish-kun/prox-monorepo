/**
 * Formatting and axis helpers for the forecast charts. React-free.
 */

import { DAY, HOUR } from '../quotaForecastModel';

const makeFormatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en-US', options);
  }
};

export const formatPercent = (value: number, locale?: string, digits = 0): string =>
  `${value.toLocaleString(locale, { maximumFractionDigits: digits })}%`;

export const formatRate = (value: number, locale?: string): string =>
  formatPercent(value, locale, value < 10 ? 1 : 0);

/** "6 hours" / "6h" / "7 days" — the unit is picked from the value unless given. */
export function formatDuration(
  seconds: number,
  locale: string | undefined,
  display: 'long' | 'narrow',
  unit?: 'hour' | 'day'
): string {
  const resolved = unit ?? (seconds >= 2 * DAY && seconds % DAY === 0 ? 'day' : 'hour');
  const value = resolved === 'day' ? seconds / DAY : seconds / HOUR;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: resolved,
      unitDisplay: display,
    }).format(value);
  } catch {
    return `${value}${resolved === 'day' ? 'd' : 'h'}`;
  }
}

export function createTimeFormatters(locale: string | undefined) {
  const full = makeFormatter(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = makeFormatter(locale, { weekday: 'short', day: 'numeric' });
  const hour = makeFormatter(locale, { hour: 'numeric' });
  const weekday = makeFormatter(locale, { weekday: 'short' });
  return {
    full: (t: number) => full.format(t * 1000),
    day: (t: number) => day.format(t * 1000),
    hour: (t: number) => hour.format(t * 1000),
    weekday: (t: number) => weekday.format(t * 1000),
  };
}

export type TimeFormatters = ReturnType<typeof createTimeFormatters>;

export interface AxisTick {
  t: number;
  label: string;
  /** Hidden on phones. */
  minor: boolean;
}

const TICK_INTERVALS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
const MAX_TICKS = 10;

/** Local-time ticks between start and end: hours for short spans, days for long ones. */
export function timeTicks(start: number, end: number, format: TimeFormatters): AxisTick[] {
  const span = Math.max(1, end - start);
  const interval =
    TICK_INTERVALS.find((candidate) => span / candidate <= MAX_TICKS) ??
    TICK_INTERVALS[TICK_INTERVALS.length - 1];
  const ticks: AxisTick[] = [];
  const date = new Date(start * 1000);
  if (interval < DAY) {
    const stepHours = interval / HOUR;
    date.setMinutes(0, 0, 0);
    while (date.getTime() / 1000 < start || date.getHours() % stepHours !== 0) {
      date.setHours(date.getHours() + 1);
    }
    while (date.getTime() / 1000 <= end) {
      const t = Math.round(date.getTime() / 1000);
      ticks.push({
        t,
        label: date.getHours() === 0 ? format.weekday(t) : format.hour(t),
        minor: false,
      });
      date.setHours(date.getHours() + stepHours);
    }
  } else {
    const stepDays = interval / DAY;
    date.setHours(0, 0, 0, 0);
    if (date.getTime() / 1000 < start) date.setDate(date.getDate() + 1);
    while (date.getTime() / 1000 <= end) {
      const t = Math.round(date.getTime() / 1000);
      ticks.push({ t, label: format.day(t), minor: false });
      date.setDate(date.getDate() + stepDays);
    }
  }
  return ticks.map((tick, index) => ({ ...tick, minor: ticks.length > 5 && index % 2 === 1 }));
}

/** A round upper bound for a bar scale. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= value) return factor * magnitude;
  }
  return 10 * magnitude;
}
