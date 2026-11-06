/**
 * One provider's accounts under a single-line capacity header: a square per
 * account (coloured by status) and how many can serve right now.
 *
 * The section is the container the rows query for their narrow layout, and it
 * sets how many limit columns every row lays out (`--quota-limit-columns`).
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { formatRelativeInstant } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import { summarizeProviderGroup, type QuotaRowStatus } from '../quotaRowSummary';
import styles from './QuotaProviderGroup.module.scss';

const SQUARE_CLASS: Record<QuotaRowStatus['kind'], string> = {
  ok: styles.squareOk,
  exhausted: styles.squareWarn,
  logged_out: styles.squareBad,
  error: styles.squareBad,
  disabled: styles.squareIdle,
  idle: styles.squareIdle,
  loading: styles.squareIdle,
};

export type QuotaProviderGroupProps = {
  type: QuotaProviderType;
  statuses: QuotaRowStatus[];
  now: number;
  resolvedTheme: ResolvedTheme;
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  /** Routing order line shown under the header. */
  routing?: ReactNode;
  /** Limit columns of every row, so limits line up (see `limitColumnCount`). */
  limitColumns?: number;
  children: ReactNode;
};

export function QuotaProviderGroup({
  type,
  statuses,
  now,
  resolvedTheme,
  refreshing,
  canRefresh,
  onRefresh,
  routing,
  limitColumns,
  children,
}: QuotaProviderGroupProps) {
  const { t, i18n } = useTranslation();
  const label = getTypeLabel(t, type);
  const iconSrc = getAuthFileIcon(type, resolvedTheme);
  const summary = summarizeProviderGroup(statuses);

  return (
    <section
      className={styles.group}
      aria-label={label}
      style={
        limitColumns ? ({ '--quota-limit-columns': limitColumns } as CSSProperties) : undefined
      }
    >
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(type)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span>{label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <h2 className={styles.title}>{label}</h2>
        <span className={styles.squares} aria-hidden="true">
          {statuses.map((status, index) => (
            <i key={index} className={`${styles.square} ${SQUARE_CLASS[status.kind]}`} />
          ))}
        </span>
        <span
          className={styles.count}
          title={t('quota_management.group_available', {
            available: summary.available,
            total: summary.total,
          })}
        >
          {summary.available}/{summary.total}
        </span>
        {summary.nextBackAtMs !== null && (
          <span className={styles.next}>
            {t('quota_management.row_back', {
              relative: formatRelativeInstant(summary.nextBackAtMs, now, i18n.resolvedLanguage),
            })}
          </span>
        )}
        <button
          type="button"
          className={styles.refresh}
          onClick={onRefresh}
          disabled={!canRefresh || refreshing}
          aria-label={t('quota_management.group_refresh', { provider: label })}
          title={t('quota_management.group_refresh', { provider: label })}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
        </button>
      </header>
      {routing}
      <div className={styles.rows}>{children}</div>
    </section>
  );
}
