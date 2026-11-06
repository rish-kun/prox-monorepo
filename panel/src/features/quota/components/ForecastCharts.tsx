/**
 * Hand-built SVG charts for the remaining-quota forecast: the remaining area
 * (history solid, projection dashed, dotted "Now") and the drain-rate bars.
 * Pixel geometry comes from the measured canvas so strokes and dashes stay
 * crisp at any width. Hover shows a crosshair tooltip; the same figures are
 * in a visually hidden table.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HOUR,
  MINUTE,
  nearestPoint,
  type ForecastPoint,
  type QuotaForecast,
} from '../quotaForecastModel';
import {
  createTimeFormatters,
  formatPercent,
  formatRate,
  niceMax,
  timeTicks,
  type AxisTick,
} from './forecastFormat';
import styles from './QuotaForecast.module.scss';

const Y_RATIOS = [1, 0.75, 0.5, 0.25, 0];

function useCanvasSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Line and closed area paths for the non-null runs of a series. */
function seriesPaths(
  points: readonly ForecastPoint[],
  x: (t: number) => number,
  y: (value: number) => number,
  baseline: number
): { line: string; area: string } {
  let line = '';
  let area = '';
  let run: string[] = [];
  let runStart = 0;
  let runEnd = 0;
  const flush = () => {
    if (run.length === 0) return;
    line += `M${run.join('L')}`;
    area += `M${runStart.toFixed(1)},${baseline}L${run.join('L')}L${runEnd.toFixed(1)},${baseline}Z`;
    run = [];
  };
  for (const point of points) {
    if (point.total === null) {
      flush();
      continue;
    }
    const px = x(point.t);
    if (run.length === 0) runStart = px;
    runEnd = px;
    run.push(`${px.toFixed(1)},${y(point.total).toFixed(1)}`);
  }
  flush();
  return { line, area };
}

const tooltipShift = (ratio: number) =>
  ratio < 0.2 ? 'translateX(-10%)' : ratio > 0.8 ? 'translateX(-90%)' : 'translateX(-50%)';

function XAxis({
  ticks,
  x,
  width,
}: {
  ticks: AxisTick[];
  x: (t: number) => number;
  width: number;
}) {
  if (width <= 0) return <div className={styles.xAxis} aria-hidden="true" />;
  return (
    <div className={styles.xAxis} aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={tick.t}
          className={`${styles.xTick} ${tick.minor ? styles.xTickMinor : ''}`}
          style={{ left: `${(x(tick.t) / width) * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

interface RemainingChartProps {
  forecast: QuotaForecast;
  labelFor: (authIndex: string) => string;
  summary: string;
}

export function ForecastRemainingChart({ forecast, labelFor, summary }: RemainingChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const format = useMemo(() => createTimeFormatters(locale), [locale]);
  const [canvasRef, { width, height }] = useCanvasSize<HTMLDivElement>();
  const [active, setActive] = useState<ForecastPoint | null>(null);
  const fillGradientId = `forecast-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { start, end, now } = forecast;
  const max = forecast.max > 0 ? forecast.max : 100;
  const x = (time: number) => ((time - start) / Math.max(1, end - start)) * width;
  const y = (value: number) => height - (Math.min(max, Math.max(0, value)) / max) * height;

  const history = width > 0 ? seriesPaths(forecast.past, x, y, height) : null;
  const projected = width > 0 ? seriesPaths(forecast.projection, x, y, height) : null;
  const allPoints = useMemo(
    () => [...forecast.past, ...forecast.projection.slice(1)],
    [forecast.past, forecast.projection]
  );
  const ticks = useMemo(() => timeTicks(start, end, format), [start, end, format]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setActive(nearestPoint(allPoints, start + ratio * (end - start)));
  };

  // Table rows: the past grid and the projection every 3 h (weekly) / 30 min (5-hour).
  const tableStep = forecast.window === 'weekly' ? 3 * HOUR : 30 * MINUTE;
  const tableRows = useMemo(
    () => [
      ...forecast.past,
      ...forecast.projection.filter((point) => point.t > now && (point.t - now) % tableStep === 0),
    ],
    [forecast.past, forecast.projection, now, tableStep]
  );

  const nowX = x(now);
  const activeX = active ? x(active.t) : 0;
  const activeRatio = width > 0 ? activeX / width : 0;

  return (
    <figure className={styles.chart}>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {Y_RATIOS.map((ratio) => (
            <span key={ratio} className={styles.yTick} style={{ top: `${(1 - ratio) * 100}%` }}>
              {formatPercent(max * ratio, locale)}
            </span>
          ))}
        </div>

        <div
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label={summary}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
        >
          {width > 0 && height > 0 && (
            <svg className={styles.svg} width={width} height={height} aria-hidden="true">
              <defs>
                <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" className={styles.fillStopTop} />
                  <stop offset="1" className={styles.fillStopBottom} />
                </linearGradient>
              </defs>
              {Y_RATIOS.map((ratio) => (
                <line
                  key={ratio}
                  className={ratio === 0 ? styles.baseline : styles.gridline}
                  x1={0}
                  x2={width}
                  y1={Math.round(y(max * ratio)) + 0.5}
                  y2={Math.round(y(max * ratio)) + 0.5}
                />
              ))}
              {projected && <path className={styles.projectedArea} d={projected.area} />}
              {history && (
                <path
                  className={styles.historyArea}
                  d={history.area}
                  style={{ fill: `url(#${fillGradientId})` }}
                />
              )}
              {projected && <path className={styles.projectedLine} d={projected.line} />}
              {history && <path className={styles.historyLine} d={history.line} />}
              <line className={styles.nowLine} x1={nowX} x2={nowX} y1={0} y2={height} />
              {active && (
                <>
                  <line className={styles.crosshair} x1={activeX} x2={activeX} y1={0} y2={height} />
                  {active.total !== null && (
                    <circle className={styles.hoverDot} cx={activeX} cy={y(active.total)} r={4} />
                  )}
                </>
              )}
            </svg>
          )}
          {width > 0 && (
            <span className={styles.nowLabel} style={{ left: nowX }} aria-hidden="true">
              {t('quota_forecast.now')}
            </span>
          )}

          {active && (
            <div
              className={styles.tooltip}
              style={{ left: `${activeRatio * 100}%`, transform: tooltipShift(activeRatio) }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>
                {format.full(active.t)}
                {active.t > now && (
                  <span className={styles.tooltipTag}>{t('quota_forecast.legend_projected')}</span>
                )}
              </span>
              <span className={`${styles.tooltipRow} ${styles.tooltipTotal}`}>
                <span>{t('quota_forecast.tooltip_total')}</span>
                <b>
                  {active.total === null ? '—' : formatPercent(active.total, locale)}
                  {' / '}
                  {formatPercent(max, locale)}
                </b>
              </span>
              {forecast.accounts
                .filter((account) => account.authIndex in active.byAccount)
                .map((account) => (
                  <span key={account.authIndex} className={styles.tooltipRow}>
                    <span>{labelFor(account.authIndex)}</span>
                    <b>{formatPercent(active.byAccount[account.authIndex], locale)}</b>
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>

      <XAxis ticks={ticks} x={x} width={width} />

      <table className={styles.srOnly}>
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">{t('quota_forecast.table_time')}</th>
            <th scope="col">{t('quota_forecast.legend_remaining')}</th>
          </tr>
        </thead>
        <tbody>
          {tableRows.map((point, index) => (
            <tr key={`${point.t}-${index}`}>
              <th scope="row">
                {format.full(point.t)}
                {point.t > now ? ` (${t('quota_forecast.legend_projected')})` : ''}
              </th>
              <td>{point.total === null ? '—' : formatPercent(point.total, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

interface DrainChartProps {
  forecast: QuotaForecast;
  summary: string;
}

export function ForecastDrainChart({ forecast, summary }: DrainChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const format = useMemo(() => createTimeFormatters(locale), [locale]);
  const [canvasRef, { width, height }] = useCanvasSize<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const bars = forecast.drainBars;
  const start = bars.length > 0 ? bars[0].start : forecast.start;
  const end = forecast.now;
  const peak = bars.reduce((value, bar) => Math.max(value, bar.ratePerHour), forecast.drainAverage);
  const scaleMax = niceMax(peak * 1.1);
  const x = (time: number) => ((time - start) / Math.max(1, end - start)) * width;
  const y = (value: number) =>
    height - (Math.min(scaleMax, Math.max(0, value)) / scaleMax) * height;
  const ticks = useMemo(() => timeTicks(start, end, format), [start, end, format]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || bars.length === 0) return;
    const time = start + ((event.clientX - rect.left) / rect.width) * (end - start);
    const index = bars.findIndex((bar) => time >= bar.start && time < bar.end);
    setActiveIndex(index === -1 ? bars.length - 1 : index);
  };

  const active = activeIndex === null ? null : (bars[activeIndex] ?? null);
  const activeRatio =
    active && width > 0 ? x((active.start + Math.min(active.end, end)) / 2) / width : 0;
  const averageY = y(forecast.drainAverage);

  return (
    <figure className={styles.chart}>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {[1, 0.5, 0].map((ratio) => (
            <span key={ratio} className={styles.yTick} style={{ top: `${(1 - ratio) * 100}%` }}>
              {formatRate(scaleMax * ratio, locale)}
            </span>
          ))}
        </div>

        <div
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label={summary}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActiveIndex(null)}
        >
          {width > 0 && height > 0 && (
            <svg className={styles.svg} width={width} height={height} aria-hidden="true">
              {[1, 0.5, 0].map((ratio) => (
                <line
                  key={ratio}
                  className={ratio === 0 ? styles.baseline : styles.gridline}
                  x1={0}
                  x2={width}
                  y1={Math.round(y(scaleMax * ratio)) + 0.5}
                  y2={Math.round(y(scaleMax * ratio)) + 0.5}
                />
              ))}
              {bars.map((bar, index) => {
                if (bar.ratePerHour <= 0) return null;
                const left = Math.max(0, x(bar.start));
                const right = Math.min(width, x(bar.end));
                const barWidth = Math.max(1, right - left - (right - left > 4 ? 2 : 0));
                const top = y(bar.ratePerHour);
                return (
                  <rect
                    key={bar.start}
                    className={index === activeIndex ? styles.barActive : styles.bar}
                    x={left}
                    y={Math.min(top, height - 1)}
                    width={barWidth}
                    height={Math.max(1, height - top)}
                    rx={1}
                  />
                );
              })}
              {forecast.drainAverage > 0 && (
                <line
                  className={styles.averageLine}
                  x1={0}
                  x2={width}
                  y1={averageY}
                  y2={averageY}
                />
              )}
            </svg>
          )}
          {width > 0 && forecast.drainAverage > 0 && (
            <span className={styles.averageLabel} style={{ top: averageY }} aria-hidden="true">
              {t('quota_forecast.drain_average', {
                rate: formatRate(forecast.drainAverage, locale),
              })}
            </span>
          )}

          {active && (
            <div
              className={styles.tooltip}
              style={{ left: `${activeRatio * 100}%`, transform: tooltipShift(activeRatio) }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>{format.full(active.start)}</span>
              <span className={styles.tooltipRow}>
                <span>{t('quota_forecast.table_drain')}</span>
                <b>{formatRate(active.ratePerHour, locale)}</b>
              </span>
            </div>
          )}
        </div>
      </div>

      <XAxis ticks={ticks} x={x} width={width} />

      <table className={styles.srOnly}>
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">{t('quota_forecast.table_time')}</th>
            <th scope="col">{t('quota_forecast.table_drain')}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.start}>
              <th scope="row">{format.full(bar.start)}</th>
              <td>{formatRate(bar.ratePerHour, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
