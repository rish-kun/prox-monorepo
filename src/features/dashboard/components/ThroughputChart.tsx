import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentRequestBucket } from '@/utils/recentRequests';
import { formatPercent } from '@/utils/format';
import { BUCKET_MINUTES, sumBuckets } from '../model';
import { axisMax } from '../utils';
import styles from './ThroughputChart.module.scss';

/** Gridlines including zero, i.e. TICK_COUNT - 1 intervals. */
const TICK_COUNT = 4;

/**
 * Bucket label. The backend sends server-local strings ("15:04-15:14"); prefer
 * them over reconstructing from the browser clock, which may sit in another
 * time zone.
 */
function bucketRangeLabel(time: string | undefined, index: number, count: number): string {
  if (time) return time;
  return `-${(count - index) * BUCKET_MINUTES}m`;
}

function bucketStartLabel(time: string | undefined, index: number, count: number): string {
  if (!time) return bucketRangeLabel(time, index, count);
  const [start] = time.split('-');
  return start?.trim() || time;
}

interface ThroughputChartProps {
  buckets: RecentRequestBucket[];
}

/**
 * Stacked success/failure bars, one per 10-minute bucket. Static — no entry
 * animation. Hover shows a bucket's figures; the same figures are always
 * available in the collapsible data table below.
 */
export function ThroughputChart({ buckets }: ThroughputChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const totals = useMemo(() => sumBuckets(buckets), [buckets]);
  const peak = useMemo(
    () => buckets.reduce((max, bucket) => Math.max(max, bucket.success + bucket.failed), 0),
    [buckets]
  );
  const scaleMax = axisMax(peak, TICK_COUNT - 1);
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const ratio = 1 - index / (TICK_COUNT - 1);
    return { ratio, value: Math.round(scaleMax * ratio) };
  });
  const xTicks = Array.from(new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]))
    .filter((index) => index >= 0)
    .map((index) => ({
      index,
      label: bucketStartLabel(buckets[index]?.time, index, buckets.length),
    }));

  const summary = t('dashboard.traffic_chart_summary', {
    total: totals.total,
    success: totals.success,
    failed: totals.failure,
    minutes: buckets.length * BUCKET_MINUTES,
  });

  const active = activeIndex === null ? null : (buckets[activeIndex] ?? null);
  const activeTotal = active ? active.success + active.failed : 0;

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
              {tick.value.toLocaleString()}
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
            className={styles.columns}
            role="img"
            aria-label={summary}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {buckets.map((bucket, index) => (
              <div
                key={bucket.time ?? index}
                className={`${styles.column} ${activeIndex === index ? styles.columnActive : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <div className={styles.stack}>
                  {bucket.failed > 0 && (
                    <span
                      className={`${styles.segment} ${styles.segmentFailure}`}
                      style={{ height: `${(bucket.failed / scaleMax) * 100}%` }}
                    />
                  )}
                  {bucket.success > 0 && (
                    <span
                      className={`${styles.segment} ${styles.segmentSuccess}`}
                      style={{ height: `${(bucket.success / scaleMax) * 100}%` }}
                    />
                  )}
                  {bucket.success + bucket.failed === 0 && <span className={styles.idleTick} />}
                </div>
              </div>
            ))}
          </div>

          {active && activeIndex !== null && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((activeIndex + 0.5) / buckets.length) * 100}%`,
                transform:
                  activeIndex < buckets.length * 0.2
                    ? 'translateX(-10%)'
                    : activeIndex > buckets.length * 0.8
                      ? 'translateX(-90%)'
                      : 'translateX(-50%)',
              }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>
                {bucketRangeLabel(active.time, activeIndex, buckets.length)}
              </span>
              <span className={styles.tooltipRow}>
                <i className={`${styles.swatch} ${styles.swatchSuccess}`} />
                {t('stats.success')}
                <b>{active.success.toLocaleString()}</b>
              </span>
              <span className={styles.tooltipRow}>
                <i className={`${styles.swatch} ${styles.swatchFailure}`} />
                {t('stats.failure')}
                <b>{active.failed.toLocaleString()}</b>
              </span>
              {activeTotal > 0 && (
                <span className={styles.tooltipRate}>
                  {formatPercent((active.success / activeTotal) * 100)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((tick) => (
          <span
            key={tick.index}
            className={styles.xTick}
            style={{ left: `${((tick.index + 0.5) / buckets.length) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <details className={styles.tableToggle}>
        <summary>{t('dashboard.traffic_table')}</summary>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.traffic_table_window')}</th>
              <th scope="col">{t('stats.success')}</th>
              <th scope="col">{t('stats.failure')}</th>
              <th scope="col">{t('dashboard.success_rate')}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, index) => {
              const bucketTotal = bucket.success + bucket.failed;
              return (
                <tr key={bucket.time ?? index}>
                  <th scope="row">{bucketRangeLabel(bucket.time, index, buckets.length)}</th>
                  <td>{bucket.success.toLocaleString()}</td>
                  <td>{bucket.failed.toLocaleString()}</td>
                  <td>
                    {bucketTotal > 0 ? formatPercent((bucket.success / bucketTotal) * 100) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
