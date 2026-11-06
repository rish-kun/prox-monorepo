/**
 * Dashboard: the proxy's state on one screen, in the quota page's visual
 * language — KPI strip, request activity, one row per credential, recent
 * errors (when file logging is on) and a one-line server footer.
 *
 * Data and refresh policy live in useDashboardData; all derivation is in
 * model.ts. Window figures (10-minute buckets, 3h20m) and lifetime counters
 * (since the proxy restarted) are never mixed.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RowGroup, RowGroups } from '@/components/common/GroupedRows';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { CredentialTable } from './components/CredentialTable';
import { ThroughputChart } from './components/ThroughputChart';
import { useDashboardData } from './hooks/useDashboardData';
import {
  BUCKET_MINUTES,
  WINDOW_BUCKETS,
  buildCredentialRows,
  countCredentials,
  lifetimeTotal,
  summarizeTraffic,
  type ErrorLogEntry,
} from './model';
import { splitWindowMinutes, toneForSuccessRate } from './utils';
import styles from './dashboard.module.scss';

const DASH = '—';

/** Six digits stay exact; beyond that compact so the strip never overflows. */
const formatCount = (value: number): string =>
  value < 1_000_000 ? value.toLocaleString() : formatCompactNumber(value);

interface Kpi {
  key: string;
  label: string;
  value: string;
  tone?: 'warn' | 'bad';
  title?: string;
  quiet?: boolean;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const data = useDashboardData();
  const { connected, connectionStatus, config, files, apiKeyUsage, recentErrors } = data;

  useHeaderRefresh(data.refresh, connected);

  const minuteNow = useNow();
  const now = Math.max(minuteNow, data.filesFetchedAt);

  const rows = useMemo(
    () => (files ? buildCredentialRows(files, apiKeyUsage, now) : []),
    [files, apiKeyUsage, now]
  );
  const traffic = useMemo(() => summarizeTraffic(rows.map((row) => row.buckets)), [rows]);
  const counts = countCredentials(rows);
  const loaded = files !== null;

  const windowLabel = useMemo(() => {
    const { hours, minutes } = splitWindowMinutes(
      traffic.windowMinutes || WINDOW_BUCKETS * BUCKET_MINUTES
    );
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  }, [traffic.windowMinutes, t]);

  const rateTone = toneForSuccessRate(traffic.successRate);
  const badTone = rateTone === 'critical' ? 'bad' : rateTone === 'warning' ? 'warn' : undefined;

  const kpis: Kpi[] = [
    {
      key: 'hour',
      label: t('dashboard.kpi_requests_hour'),
      value: loaded ? formatCount(traffic.lastHour.total) : DASH,
    },
    {
      key: 'window',
      label: t('dashboard.kpi_requests_window', { window: windowLabel }),
      value: loaded ? formatCount(traffic.window.total) : DASH,
    },
    {
      key: 'rate',
      label: t('dashboard.kpi_success_window', { window: windowLabel }),
      value: loaded && traffic.successRate !== null ? formatPercent(traffic.successRate) : DASH,
      tone: badTone,
    },
    {
      key: 'failures',
      label: t('dashboard.kpi_failures_window', { window: windowLabel }),
      value: loaded ? formatCount(traffic.window.failure) : DASH,
      tone: traffic.window.failure > 0 ? badTone : undefined,
    },
    {
      key: 'credentials',
      label: t('dashboard.kpi_credentials'),
      value: loaded ? `${counts.usable}/${counts.total}` : DASH,
      tone:
        !loaded || counts.usable === counts.total
          ? undefined
          : counts.usable === 0
            ? 'bad'
            : 'warn',
    },
    {
      key: 'lifetime',
      label: t('dashboard.kpi_since_restart'),
      value: loaded ? formatCount(lifetimeTotal(rows)) : DASH,
      title: t('dashboard.kpi_since_restart_hint'),
      quiet: true,
    },
  ];

  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );
  const version = serverVersion?.trim() ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : null;
  const routing = config?.routingStrategy?.trim() || null;
  const footerParts = [
    version,
    routing,
    config ? t('dashboard.footer_retry', { count: config.requestRetry ?? 0 }) : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t('dashboard.title')}</h1>

      <section className={styles.kpis} aria-label={t('dashboard.kpi_aria')}>
        <dl className={styles.kpiList}>
          {kpis.map((kpi) => (
            <div
              key={kpi.key}
              className={`${styles.kpi} ${kpi.quiet ? styles.kpiQuiet : ''}`}
              title={kpi.title}
            >
              <dt className={styles.kpiLabel}>{kpi.label}</dt>
              <dd className={`${styles.kpiValue} ${kpi.tone ? styles[kpi.tone] : ''}`}>
                {kpi.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <RowGroups>
        <RowGroup
          label={t('dashboard.activity_title')}
          title={t('dashboard.activity_title')}
          summary={
            traffic.buckets.length > 0 ? (
              <>
                <span className={styles.legend}>
                  <i className={`${styles.swatch} ${styles.swatchSuccess}`} aria-hidden="true" />
                  {t('stats.success')}
                </span>
                <span className={styles.legend}>
                  <i className={`${styles.swatch} ${styles.swatchFailure}`} aria-hidden="true" />
                  {t('stats.failure')}
                </span>
                <span className={styles.mono}>
                  {t('dashboard.activity_stats', {
                    peak: traffic.peak.toLocaleString(),
                    current: traffic.current.toLocaleString(),
                  })}
                </span>
              </>
            ) : undefined
          }
        >
          {traffic.buckets.length > 0 ? (
            <div className={styles.chartBody}>
              <ThroughputChart buckets={traffic.buckets} />
            </div>
          ) : (
            <p className={styles.empty}>{loaded ? t('dashboard.activity_empty') : DASH}</p>
          )}
        </RowGroup>

        <RowGroup
          label={t('dashboard.credentials_title')}
          title={t('dashboard.credentials_title')}
          summary={
            loaded ? (
              <span className={styles.mono}>
                {t('dashboard.credentials_summary', {
                  usable: counts.usable,
                  total: counts.total,
                })}
              </span>
            ) : undefined
          }
        >
          {rows.length > 0 ? (
            <CredentialTable rows={rows} now={now} />
          ) : (
            <p className={styles.empty}>{loaded ? t('dashboard.credentials_empty') : DASH}</p>
          )}
        </RowGroup>

        {data.loggingToFile && (
          <RowGroup
            label={t('dashboard.errors_title')}
            title={t('dashboard.errors_title')}
            actions={
              <Link to="/logs" className={styles.headLink}>
                {t('dashboard.errors_logs_link')} <span aria-hidden="true">→</span>
              </Link>
            }
          >
            <RecentErrors entries={recentErrors} />
          </RowGroup>
        )}
      </RowGroups>

      <footer className={styles.footer}>
        {footerParts.map((part) => (
          <span key={part} className={styles.footerPart}>
            {part}
          </span>
        ))}
        <span className={styles.footerPart}>
          <i
            className={`${styles.connDot} ${
              connectionStatus === 'connected'
                ? styles.connOk
                : connectionStatus === 'connecting'
                  ? styles.connWarn
                  : styles.connBad
            }`}
            aria-hidden="true"
          />
          {connectionLabel}
        </span>
      </footer>
    </div>
  );
}

function RecentErrors({ entries }: { entries: ErrorLogEntry[] | null }) {
  const { t } = useTranslation();
  if (entries === null) return <p className={styles.empty}>{DASH}</p>;
  if (entries.length === 0) return <p className={styles.empty}>{t('dashboard.errors_empty')}</p>;
  return (
    <table className={styles.errors}>
      <thead className={styles.srOnly}>
        <tr>
          <th scope="col">{t('dashboard.col_time')}</th>
          <th scope="col">{t('dashboard.col_status')}</th>
          <th scope="col">{t('dashboard.col_request')}</th>
          <th scope="col">{t('dashboard.col_latency')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.key}>
            <td className={styles.errTime}>{entry.time || DASH}</td>
            <td className={entry.status >= 500 ? styles.bad : styles.warn}>{entry.status}</td>
            <td className={styles.errRequest} title={`${entry.method} ${entry.path}`}>
              <span className={styles.errMethod}>{entry.method}</span> {entry.path}
            </td>
            <td className={styles.errLatency}>{entry.latency ?? DASH}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
