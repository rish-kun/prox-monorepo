/**
 * Remaining-quota forecast at the top of the Quota page: recorded history up
 * to now, a dashed projection forward (drain rate + routing priorities +
 * resets, bursting accounts first) and a drain-rate tab. Data: `GET /quota/history`, refetched every
 * 60 s while open and visible; every derivation is in quotaForecastModel.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { getTypeLabel } from '@/features/authFiles/constants';
import { useNow } from '@/hooks/useNow';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { useQuotaHistory } from '../hooks/useQuotaHistory';
import {
  DAY,
  FORECAST_HORIZONS,
  FORECAST_LOOKBACKS,
  buildQuotaForecast,
  formatNextReset,
  historySpanFor,
  type ForecastBurst,
  type ForecastWindow,
} from '../quotaForecastModel';
import {
  readQuotaForecastSettings,
  writeQuotaForecastSettings,
  type QuotaForecastProvider,
  type QuotaForecastSettings,
  type QuotaForecastTab,
} from '../uiState';
import { ForecastDrainChart, ForecastRemainingChart } from './ForecastCharts';
import { formatDuration, formatPercent, formatRate } from './forecastFormat';
import styles from './QuotaForecast.module.scss';

/** One fixed request span covers every horizon and lookback, so switching them never refetches. */
const HISTORY_SPAN = historySpanFor(
  Math.max(...FORECAST_HORIZONS.weekly, ...FORECAST_HORIZONS['5h']),
  Math.max(...FORECAST_LOOKBACKS)
);

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  mono = false,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  mono?: boolean;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${mono ? styles.segmentMono : ''} ${
            option.value === value ? styles.segmentActive : ''
          }`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type QuotaForecastProps = {
  /** Providers with at least one credential, in display order. */
  providers: readonly QuotaForecastProvider[];
  /** Credential list, for account names when the proxy has no label. */
  files: readonly AuthFileItem[];
  open: boolean;
  onToggle: () => void;
  /** False while disconnected: nothing is fetched. */
  enabled: boolean;
  /** Running "Prioritise plan" bursts, in routing order. */
  bursts?: readonly ForecastBurst[];
};

const NO_BURSTS: readonly ForecastBurst[] = [];

export function QuotaForecast({
  providers,
  files,
  open,
  onToggle,
  enabled,
  bursts = NO_BURSTS,
}: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [settings, setSettings] = useState<QuotaForecastSettings>(readQuotaForecastSettings);

  const update = useCallback((patch: Partial<QuotaForecastSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeQuotaForecastSettings(next);
      return next;
    });
  }, []);

  const provider = providers.includes(settings.provider) ? settings.provider : providers[0];
  const windowKind = settings.window;
  const horizon = settings.horizon[windowKind];
  const { history, error } = useQuotaHistory(provider, windowKind, HISTORY_SPAN, open && enabled);
  const nowMs = useNow(open);
  const now = Math.floor(nowMs / 1000);

  const forecast = useMemo(
    () =>
      history
        ? buildQuotaForecast({
            window: windowKind,
            samples: history.samples,
            accounts: history.accounts,
            now,
            horizon,
            lookback: settings.lookback,
            bursts,
          })
        : null,
    [bursts, history, horizon, now, settings.lookback, windowKind]
  );

  const fileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of files) {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (authIndex) map.set(authIndex, file.email?.trim() || file.name);
    }
    return map;
  }, [files]);

  const labelFor = useCallback(
    (authIndex: string) =>
      history?.accounts[authIndex]?.label || fileNames.get(authIndex) || `#${authIndex}`,
    [fileNames, history]
  );

  const providerLabel = getTypeLabel(t, provider);
  const nextReset = forecast?.nextReset ? formatNextReset(forecast.nextReset, locale) : null;
  const tab = settings.tab;

  const errorText = error
    ? error.status === 404
      ? t('quota_forecast.error_unsupported')
      : error.status === 503
        ? t('quota_forecast.error_unavailable')
        : t('quota_forecast.error_generic', {
            message: error.message || String(error.status ?? ''),
          })
    : null;

  const firstRecorded = history?.firstRecordedAt
    ? new Date(history.firstRecordedAt * 1000).toLocaleString(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  const renderChart = () => {
    if (!forecast) {
      return errorText ? (
        <p className={`${styles.empty} ${styles.error}`}>{errorText}</p>
      ) : (
        <Skeleton height={180} rounded={8} />
      );
    }
    if (!forecast.hasData) {
      return (
        <p className={styles.empty}>
          {firstRecorded
            ? t('quota_forecast.empty_since', { date: firstRecorded })
            : t('quota_forecast.empty_new')}
        </p>
      );
    }
    const current = formatPercent(forecast.current ?? 0, locale);
    const max = formatPercent(forecast.max, locale);
    const rate = formatRate(forecast.ratePerHour, locale);
    return tab === 'remaining' ? (
      <ForecastRemainingChart
        forecast={forecast}
        labelFor={labelFor}
        summary={t('quota_forecast.chart_summary', {
          provider: providerLabel,
          current,
          max,
          rate,
        })}
      />
    ) : (
      <ForecastDrainChart
        forecast={forecast}
        summary={t('quota_forecast.drain_summary', {
          provider: providerLabel,
          rate: formatRate(forecast.drainAverage, locale),
        })}
      />
    );
  };

  const windowOptions: Array<{ value: ForecastWindow; label: string }> = [
    { value: '5h', label: t('quota_forecast.window_5h') },
    { value: 'weekly', label: t('quota_forecast.window_weekly') },
  ];
  const tabOptions: Array<{ value: QuotaForecastTab; label: string }> = [
    { value: 'remaining', label: t('quota_forecast.tab_remaining') },
    { value: 'drain', label: t('quota_forecast.tab_drain') },
  ];

  return (
    <section
      className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
      aria-label={t('quota_forecast.title')}
    >
      <header className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={onToggle}>
          <IconChevronDown
            size={14}
            aria-hidden="true"
            className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
          />
          <h2 className={styles.title}>{t('quota_forecast.title')}</h2>
        </button>
        {open && providers.length > 1 && (
          <div className={styles.headActions}>
            <Segmented
              label={t('quota_forecast.provider_aria')}
              options={providers.map((value) => ({ value, label: getTypeLabel(t, value) }))}
              value={provider}
              onChange={(value) => update({ provider: value })}
            />
          </div>
        )}
      </header>

      {open && (
        <div className={styles.body}>
          {forecast?.hasData && (
            <p className={styles.headline}>
              <span className={styles.headlineValue}>
                {formatPercent(forecast.current ?? 0, locale)}
              </span>
              <span className={styles.headlineOf}>
                {t('quota_forecast.remaining_of', { max: formatPercent(forecast.max, locale) })}
              </span>
              <span className={styles.headlineRate}>
                {t('quota_forecast.per_hour', { rate: formatRate(forecast.ratePerHour, locale) })}
              </span>
            </p>
          )}

          <div className={styles.controls}>
            <Segmented
              label={t('quota_forecast.tabs_aria')}
              options={tabOptions}
              value={tab}
              onChange={(value) => update({ tab: value })}
            />
            <Segmented
              label={t('quota_forecast.window_aria')}
              options={windowOptions}
              value={windowKind}
              onChange={(value) => update({ window: value })}
            />
            {tab === 'remaining' ? (
              <>
                <ul className={styles.legend}>
                  <li>
                    <span className={styles.swatchSolid} aria-hidden="true" />
                    {t('quota_forecast.legend_remaining')}
                  </li>
                  <li>
                    <span className={styles.swatchDashed} aria-hidden="true" />
                    {t('quota_forecast.legend_projected')}
                  </li>
                </ul>
                <select
                  className={styles.select}
                  aria-label={t('quota_forecast.horizon_aria')}
                  value={horizon}
                  onChange={(event) =>
                    update({
                      horizon: { ...settings.horizon, [windowKind]: Number(event.target.value) },
                    })
                  }
                >
                  {FORECAST_HORIZONS[windowKind].map((value) => (
                    <option key={value} value={value}>
                      {t('quota_forecast.next_span', {
                        span: formatDuration(
                          value,
                          locale,
                          'long',
                          windowKind === '5h' || value < DAY ? 'hour' : 'day'
                        ),
                      })}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>

          {renderChart()}

          {forecast?.hasData && (nextReset || errorText) && (
            <div className={styles.footer}>
              {nextReset && (
                <span className={styles.nextReset}>
                  {t('quota_forecast.next_reset', nextReset)}
                </span>
              )}
              {errorText && <span className={styles.error}>{errorText}</span>}
            </div>
          )}

          <details className={styles.settings}>
            <summary>{t('quota_forecast.settings')}</summary>
            <div className={styles.settingRow}>
              <span>{t('quota_forecast.lookback_label')}</span>
              <Segmented
                label={t('quota_forecast.lookback_label')}
                options={FORECAST_LOOKBACKS.map((value) => ({
                  value,
                  label: formatDuration(value, locale, 'narrow'),
                }))}
                value={settings.lookback}
                onChange={(value) => update({ lookback: value })}
                mono
              />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
