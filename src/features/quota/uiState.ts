import {
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  DEFAULT_FORECAST_HORIZON,
  DEFAULT_FORECAST_LOOKBACK,
  FORECAST_HORIZONS,
  FORECAST_LOOKBACKS,
  type ForecastWindow,
} from './quotaForecastModel';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/**
 * 额度页视图偏好：跨会话持久化（localStorage）。
 * 与 tab/排序不同，这些是长期习惯，不应随标签页关闭而丢失。
 */
export type QuotaViewPrefs = {
  /** Whether the reset timeline below the account rows is expanded. */
  timelineOpen: boolean;
  /** Whether the remaining-quota forecast above the account rows is expanded. */
  forecastOpen: boolean;
};

export const DEFAULT_QUOTA_VIEW_PREFS: QuotaViewPrefs = {
  timelineOpen: false,
  forecastOpen: true,
};

const QUOTA_VIEW_PREFS_KEY = 'quotaPage.viewPrefs';

export const readQuotaViewPrefs = (): QuotaViewPrefs => {
  if (typeof window === 'undefined') return DEFAULT_QUOTA_VIEW_PREFS;
  try {
    const raw = window.localStorage.getItem(QUOTA_VIEW_PREFS_KEY);
    if (!raw) return DEFAULT_QUOTA_VIEW_PREFS;
    const parsed = JSON.parse(raw) as Partial<QuotaViewPrefs> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_QUOTA_VIEW_PREFS;
    return {
      timelineOpen:
        typeof parsed.timelineOpen === 'boolean'
          ? parsed.timelineOpen
          : DEFAULT_QUOTA_VIEW_PREFS.timelineOpen,
      forecastOpen:
        typeof parsed.forecastOpen === 'boolean'
          ? parsed.forecastOpen
          : DEFAULT_QUOTA_VIEW_PREFS.forecastOpen,
    };
  } catch {
    return DEFAULT_QUOTA_VIEW_PREFS;
  }
};

/** Merge-on-write for the same reason as writeQuotaUiState. */
export const writeQuotaViewPrefs = (prefs: Partial<QuotaViewPrefs>) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaViewPrefs(), ...prefs };
    window.localStorage.setItem(QUOTA_VIEW_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/**
 * Remaining-quota forecast settings (localStorage `quotaPage.forecast.v1`):
 * provider, chart tab, window, the "Next" horizon per window and the drain
 * lookback. Invalid or retired values fall back to the defaults one by one.
 */
export type QuotaForecastProvider = 'claude' | 'codex';
export type QuotaForecastTab = 'remaining' | 'drain';

export type QuotaForecastSettings = {
  provider: QuotaForecastProvider;
  tab: QuotaForecastTab;
  window: ForecastWindow;
  /** Seconds, per window. */
  horizon: Record<ForecastWindow, number>;
  /** Seconds. */
  lookback: number;
};

export const DEFAULT_QUOTA_FORECAST_SETTINGS: QuotaForecastSettings = {
  provider: 'claude',
  tab: 'remaining',
  window: 'weekly',
  horizon: { ...DEFAULT_FORECAST_HORIZON },
  lookback: DEFAULT_FORECAST_LOOKBACK,
};

const QUOTA_FORECAST_KEY = 'quotaPage.forecast.v1';

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export const readQuotaForecastSettings = (): QuotaForecastSettings => {
  const defaults = DEFAULT_QUOTA_FORECAST_SETTINGS;
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(QUOTA_FORECAST_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const horizon = (
      parsed.horizon && typeof parsed.horizon === 'object' ? parsed.horizon : {}
    ) as Record<string, unknown>;
    return {
      provider: pick(parsed.provider, ['claude', 'codex'] as const, defaults.provider),
      tab: pick(parsed.tab, ['remaining', 'drain'] as const, defaults.tab),
      window: pick(parsed.window, ['5h', 'weekly'] as const, defaults.window),
      horizon: {
        '5h': pick(horizon['5h'], FORECAST_HORIZONS['5h'], defaults.horizon['5h']),
        weekly: pick(horizon.weekly, FORECAST_HORIZONS.weekly, defaults.horizon.weekly),
      },
      lookback: pick(parsed.lookback, FORECAST_LOOKBACKS, defaults.lookback),
    };
  } catch {
    return defaults;
  }
};

export const writeQuotaForecastSettings = (settings: QuotaForecastSettings) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUOTA_FORECAST_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
};
