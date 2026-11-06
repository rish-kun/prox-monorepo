/**
 * One row per credential, problems first. The Status cell is empty for a
 * healthy credential — it only speaks for a cooldown, an error, exhaustion or
 * a disabled credential. Quota windows are the proxy's passive observations.
 */

import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { formatRelativeInstant } from '@/utils/quota';
import type { RecentRequestBucket } from '@/utils/recentRequests';
import type { QuotaLimitSummary } from '@/features/quota/quotaRowSummary';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { BUCKET_MINUTES, type CredentialRow, type CredentialStatus } from '../model';
import { providerLabel } from '../utils';
import styles from './CredentialTable.module.scss';

const DASH = '—';
const MINUTE_MS = 60_000;

function ProviderIcon({ provider, theme }: { provider: string; theme: ResolvedTheme }) {
  const src = getAuthFileIcon(provider, theme);
  return (
    <span
      className={styles.icon}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(theme) }
          : undefined
      }
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" /> : provider.slice(0, 1).toUpperCase()}
    </span>
  );
}

function MiniBars({ buckets }: { buckets: RecentRequestBucket[] }) {
  const max = buckets.reduce((peak, bucket) => Math.max(peak, bucket.success + bucket.failed), 0);
  return (
    <span className={styles.bars} aria-hidden="true">
      {buckets.map((bucket, index) => {
        const total = bucket.success + bucket.failed;
        if (total === 0) return <span key={index} className={styles.barIdle} />;
        return (
          <span
            key={index}
            className={styles.bar}
            style={{ height: `${Math.max(8, (total / max) * 100)}%` }}
          >
            {bucket.failed > 0 && (
              <span
                className={styles.barFail}
                style={{ height: `${(bucket.failed / total) * 100}%` }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

function LimitCell({
  limit,
  label,
  now,
  locale,
}: {
  limit: QuotaLimitSummary | null;
  label: string;
  now: number;
  locale?: string;
}) {
  if (!limit || limit.remaining === null) {
    return (
      <span role="cell" className={`${styles.limit} ${styles.limitEmpty}`}>
        <span className={styles.muted}>{DASH}</span>
      </span>
    );
  }
  const remaining = Math.round(limit.remaining);
  const tone = remaining === 0 ? styles.bad : remaining < 30 ? styles.warn : '';
  return (
    <span role="cell" className={styles.limit}>
      <span className={styles.cellLabel}>{label}</span>
      <span className={`${styles.mono} ${tone}`}>{remaining}%</span>
      {limit.resetAtMs !== null && (
        <span className={styles.reset}>{formatRelativeInstant(limit.resetAtMs, now, locale)}</span>
      )}
    </span>
  );
}

function useStatusText(status: CredentialStatus, now: number, locale?: string) {
  const { t } = useTranslation();
  const relative = (ms: number) => formatRelativeInstant(ms, now, locale);
  switch (status.kind) {
    case 'disabled':
      return { text: t('dashboard.status_disabled'), tone: styles.muted };
    case 'exhausted':
      return {
        text:
          status.backAtMs === null
            ? t('dashboard.status_exhausted')
            : t('dashboard.status_exhausted_back', { relative: relative(status.backAtMs) }),
        tone: styles.warn,
      };
    case 'cooldown': {
      const at = relative(now + status.seconds * 1000);
      return {
        text: status.credentialWide
          ? t('dashboard.status_cooldown', { relative: at })
          : t('dashboard.status_model_cooldown', { count: status.models, relative: at }),
        tone: status.credentialWide ? styles.warn : styles.muted,
      };
    }
    case 'error': {
      const message = status.message || t('dashboard.status_unavailable');
      return {
        text:
          status.httpStatus !== undefined
            ? `${t('dashboard.status_http', { status: status.httpStatus })} · ${message}`
            : message,
        tone: styles.bad,
      };
    }
    default:
      return null;
  }
}

function Row({ row, now, theme }: { row: CredentialRow; now: number; theme: ResolvedTheme }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const status = useStatusText(row.status, now, locale);
  const provider = providerLabel(row.provider, t('dashboard.provider_unknown'));
  const lastUsed =
    row.lastUsedBucketsAgo === null
      ? DASH
      : row.lastUsedBucketsAgo === 0
        ? t('dashboard.last_used_now')
        : formatRelativeInstant(
            now - row.lastUsedBucketsAgo * BUCKET_MINUTES * MINUTE_MS,
            now,
            locale
          );

  return (
    <div
      role="row"
      className={`${styles.row} ${row.status.kind === 'disabled' ? styles.dimmed : ''}`}
    >
      <span role="cell" className={styles.identity} title={`${provider} · ${row.title}`}>
        <ProviderIcon provider={row.provider} theme={theme} />
        <span className={styles.srOnly}>{provider} </span>
        <span className={`${styles.name} ${row.mono ? styles.mono : ''}`}>{row.name}</span>
      </span>
      <span role="cell" className={`${styles.requests} ${styles.mono}`}>
        {row.window.total.toLocaleString()}
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={row.window.failure > 0 ? styles.bad : styles.muted}>
          {row.window.failure.toLocaleString()}
        </span>
      </span>
      <span role="cell" className={styles.trend}>
        <MiniBars buckets={row.buckets} />
      </span>
      <LimitCell
        limit={row.fiveHour}
        label={t('dashboard.col_five_hour')}
        now={now}
        locale={locale}
      />
      <LimitCell limit={row.weekly} label={t('dashboard.col_weekly')} now={now} locale={locale} />
      <span role="cell" className={`${styles.lastUsed} ${styles.muted}`}>
        {lastUsed}
      </span>
      <span
        role="cell"
        className={`${styles.status} ${status?.tone ?? ''}`}
        title={status?.text ?? undefined}
      >
        {status?.text ?? ''}
      </span>
    </div>
  );
}

export function CredentialTable({ rows, now }: { rows: CredentialRow[]; now: number }) {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.resolvedTheme);

  return (
    <div role="table" aria-label={t('dashboard.credentials_title')} className={styles.table}>
      <div role="rowgroup">
        <div role="row" className={`${styles.row} ${styles.head}`}>
          <span role="columnheader">{t('dashboard.col_credential')}</span>
          <span role="columnheader">{t('dashboard.col_requests')}</span>
          <span role="columnheader">{t('dashboard.col_trend')}</span>
          <span role="columnheader">{t('dashboard.col_five_hour')}</span>
          <span role="columnheader">{t('dashboard.col_weekly')}</span>
          <span role="columnheader">{t('dashboard.col_last_used')}</span>
          <span role="columnheader">{t('dashboard.col_status')}</span>
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((row) => (
          <Row key={row.key} row={row} now={now} theme={theme} />
        ))}
      </div>
    </div>
  );
}
