import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageBucket } from '@/services/api/usage';
import { formatCompactNumber } from '@/utils/format';
import {
  chartScaleMax,
  costState,
  formatUsd,
  formatUsdTick,
  type ChartBucket,
  type UsageTotals,
} from '../model';
import styles from './UsageChart.module.scss';

export type ChartMetric = 'tokens' | 'cost';

/** Gridlines including zero, i.e. TICK_COUNT - 1 intervals. */
const TICK_COUNT = 4;
const X_TICKS = 5;

const metricValue = (totals: UsageTotals, metric: ChartMetric): number =>
  metric === 'tokens' ? totals.total : totals.cost;

function useBucketFormatters(bucket: UsageBucket, locale: string | undefined) {
  return useMemo(() => {
    const make = (options: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale, options);
      } catch {
        return new Intl.DateTimeFormat('en-US', options);
      }
    };
    const axis =
      bucket === 'hour'
        ? make({ hour: '2-digit', minute: '2-digit' })
        : make({ month: 'short', day: 'numeric' });
    const full =
      bucket === 'hour'
        ? make({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : make({ weekday: 'short', month: 'short', day: 'numeric' });
    return {
      axis: (start: number) => axis.format(start * 1000),
      full: (start: number) => full.format(start * 1000),
    };
  }, [bucket, locale]);
}

interface UsageChartProps {
  buckets: ChartBucket[];
  bucket: UsageBucket;
  metric: ChartMetric;
}

/**
 * One bar per hour or local day. Static — no entry animation. Hover shows a
 * bucket's figures; the same figures are always in the data table below.
 */
export function UsageChart({ buckets, bucket, metric }: UsageChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const format = useBucketFormatters(bucket, locale);

  const peak = useMemo(
    () => buckets.reduce((max, entry) => Math.max(max, metricValue(entry.totals, metric)), 0),
    [buckets, metric]
  );
  const scaleMax = chartScaleMax(peak, TICK_COUNT - 1, metric === 'tokens');
  const formatValue = (value: number) =>
    metric === 'tokens' ? formatCompactNumber(value) : formatUsdTick(value, locale);
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const ratio = 1 - index / (TICK_COUNT - 1);
    return { ratio, value: scaleMax * ratio };
  });

  const count = buckets.length;
  const xTicks = Array.from(
    new Set(
      Array.from({ length: Math.min(X_TICKS, count) }, (_, index) =>
        Math.round((index * (count - 1)) / Math.max(1, Math.min(X_TICKS, count) - 1))
      )
    )
  ).map((index, position, all) => ({
    index,
    label: format.axis(buckets[index].start),
    // Phones keep the ends and the middle only.
    minor: all.length === X_TICKS && position % 2 === 1,
  }));

  const overall = useMemo(
    () =>
      buckets.reduce(
        (sum, entry) => ({
          tokens: sum.tokens + entry.totals.total,
          cost: sum.cost + entry.totals.cost,
        }),
        { tokens: 0, cost: 0 }
      ),
    [buckets]
  );
  const summary = t('usage.chart_summary', {
    tokens: formatCompactNumber(overall.tokens),
    cost: formatUsd(overall.cost, locale),
    count,
  });

  const active = activeIndex === null ? null : (buckets[activeIndex] ?? null);
  const dense = count > 60;

  return (
    <figure className={styles.chart}>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.ratio}
              className={styles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatValue(tick.value)}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>

          <div
            className={`${styles.columns} ${dense ? styles.columnsDense : ''}`}
            role="img"
            aria-label={summary}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {buckets.map((entry, index) => {
              const value = metricValue(entry.totals, metric);
              return (
                <div
                  key={entry.start}
                  className={`${styles.column} ${activeIndex === index ? styles.columnActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {value > 0 ? (
                    <span
                      className={styles.bar}
                      style={{ height: `${Math.max(1, (value / scaleMax) * 100)}%` }}
                    />
                  ) : (
                    <span className={styles.idleTick} />
                  )}
                </div>
              );
            })}
          </div>

          {active && activeIndex !== null && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((activeIndex + 0.5) / count) * 100}%`,
                transform:
                  activeIndex < count * 0.2
                    ? 'translateX(-10%)'
                    : activeIndex > count * 0.8
                      ? 'translateX(-90%)'
                      : 'translateX(-50%)',
              }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>{format.full(active.start)}</span>
              <span className={styles.tooltipRow}>
                {t('usage.chart_tokens')}
                <b>{active.totals.total.toLocaleString()}</b>
              </span>
              <span className={styles.tooltipRow}>
                {t('usage.col_cost')}
                <b>
                  <CostText totals={active.totals} locale={locale} />
                </b>
              </span>
              <span className={styles.tooltipRow}>
                {t('usage.col_requests')}
                <b>
                  {active.totals.requests.toLocaleString()}
                  {active.totals.failed > 0 && (
                    <span className={styles.bad}> · {active.totals.failed.toLocaleString()}</span>
                  )}
                </b>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((tick) => (
          <span
            key={tick.index}
            className={`${styles.xTick} ${tick.minor ? styles.xTickMinor : ''}`}
            style={{ left: `${((tick.index + 0.5) / count) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <details className={styles.tableToggle}>
        <summary>{t('usage.chart_table')}</summary>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.col_time')}</th>
                <th scope="col">{t('usage.col_total')}</th>
                <th scope="col">{t('usage.col_cost')}</th>
                <th scope="col">{t('usage.col_requests')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((entry) => (
                <tr key={entry.start}>
                  <th scope="row">{format.full(entry.start)}</th>
                  <td>{entry.totals.total.toLocaleString()}</td>
                  <td>
                    <CostText totals={entry.totals} locale={locale} />
                  </td>
                  <td>{entry.totals.requests.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Cost for the tooltip / table, marked when part of the bucket is unpriced. */
function CostText({ totals, locale }: { totals: UsageTotals; locale?: string }) {
  const { t } = useTranslation();
  const state = costState(totals);
  if (state === 'none') return <>—</>;
  return (
    <>
      {formatUsd(totals.cost, locale)}
      {state === 'partial' && <span className={styles.partial}> {t('usage.partial')}</span>}
    </>
  );
}
