/**
 * One account as a compact row: identity, every limit with its reset, and a
 * status column that stays empty unless the account can't serve requests.
 *
 * Expanding reveals the full provider detail (plan, renewal, reset credits,
 * actions) by embedding QuotaCard, so the row never duplicates that logic.
 *
 * The status column also carries the routing actions: "Start 5h" for an idle
 * window, ⌃ "Prioritise" (until the 5-hour reset) for a running one, ⇈
 * "Prioritise until weekly reset" while weekly quota is left, and a bursting
 * account's compact tag ("#1 · 11:30 PM", ⇈ for weekly) with an × to stop.
 *
 * Limits sit in a grid whose column count the provider group sets
 * (`--quota-limit-columns`), so they line up across rows.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  IconChevronDown,
  IconChevronsUp,
  IconChevronUp,
  IconRefreshCw,
  IconTimer,
  IconX,
} from '@/components/ui/icons';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import {
  buildCompactResetDisplay,
  formatRelativeInstant,
  resolveQuotaErrorMessage,
} from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import type { QuotaCardState } from '../providers';
import { getCodexPlanLabel } from '../providers/codex/planLabel';
import type { QuotaFileEntry } from '../logic';
import { formatBurstEnd, formatBurstEndShort, type RowBurst } from '../quotaBurst';
import type { QuotaLimitSummary, QuotaRowStatus } from '../quotaRowSummary';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { QuotaCard } from './QuotaCard';
import styles from './QuotaAccountRow.module.scss';

/** Email when the credential has one; otherwise the filename without `.json`. */
function getAccountLabel(file: AuthFileItem): string {
  if (typeof file.email === 'string' && file.email.trim()) return file.email.trim();
  return getQuotaDisplayName(file).replace(/\.json$/i, '');
}

function getPlanLabel(
  t: TFunction,
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  livePlanType: string | null
): string | null {
  const fetchedPlanType =
    quota?.status === 'success' ? ((quota as { planType?: string | null }).planType ?? null) : null;
  const planType = fetchedPlanType ?? livePlanType;
  if (!planType) return null;
  if (entry.type === 'codex') return getCodexPlanLabel(t, planType);
  if (entry.type === 'claude') return t(`claude_quota.${planType}`, { defaultValue: planType });
  return null;
}

const levelClass = (remaining: number | null): string => {
  if (remaining === null) return styles.levelUnknown;
  if (remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD) return styles.levelHigh;
  if (remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD) return styles.levelMedium;
  return styles.levelLow;
};

function LimitCell({
  limit,
  now,
  locale,
}: {
  limit: QuotaLimitSummary;
  now: number;
  locale?: string;
}) {
  const { t } = useTranslation();
  const label = limit.labelKey
    ? t(limit.labelKey, { ...limit.labelParams, defaultValue: limit.label })
    : limit.label;
  const reset = buildCompactResetDisplay(limit.resetLabel, limit.resetAtMs, now, locale);
  const width = limit.remaining === null ? 0 : limit.remaining;

  return (
    <div
      className={`${styles.limit} ${limit.primary ? '' : styles.limitModel}`}
      role="group"
      aria-label={label}
      title={reset ? t('quota_management.limit_reset_title', { time: reset.full }) : undefined}
    >
      <div className={styles.limitHead}>
        <span className={styles.limitLabel} title={label}>
          {label}
        </span>
        <span className={`${styles.limitValue} ${limit.remaining === 0 ? styles.valueOut : ''}`}>
          {limit.usage
            ? `${limit.usage.limit - limit.usage.used}/${limit.usage.limit}`
            : limit.remaining === null
              ? '--'
              : `${Math.round(limit.remaining)}%`}
        </span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limit.remaining ?? undefined}
        aria-label={label}
      >
        <span
          className={`${styles.fill} ${levelClass(limit.remaining)}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className={styles.limitReset}>
        {reset ? (
          <>
            <span className={styles.resetAbsolute}>{reset.when}</span>
            {reset.relative && <span> · {reset.relative}</span>}
          </>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </div>
  );
}

export type QuotaAccountRowProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  limits: QuotaLimitSummary[];
  status: QuotaRowStatus;
  /** Plan reported by live traffic, used until an explicit fetch supplies one. */
  livePlanType?: string | null;
  now: number;
  resolvedTheme: ResolvedTheme;
  expanded: boolean;
  canRefresh: boolean;
  resetting: boolean;
  /** The 5-hour window is idle and can be opened with one tiny request. */
  canStartWindow?: boolean;
  startingWindow?: boolean;
  /** Running "Prioritise plan" burst of this account, if any. */
  burst?: RowBurst | null;
  /** The running 5-hour window can be prioritised. */
  canPrioritise?: boolean;
  /** The running weekly window can be prioritised. */
  canPrioritiseWeekly?: boolean;
  burstPending?: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onReset: () => void;
  onStartWindow?: () => void;
  onPrioritise?: () => void;
  onPrioritiseWeekly?: () => void;
  onStopBurst?: () => void;
};

export function QuotaAccountRow({
  entry,
  quota,
  limits,
  status,
  livePlanType = null,
  now,
  resolvedTheme,
  expanded,
  canRefresh,
  resetting,
  canStartWindow = false,
  startingWindow = false,
  burst = null,
  canPrioritise = false,
  canPrioritiseWeekly = false,
  burstPending = false,
  onToggle,
  onRefresh,
  onReset,
  onStartWindow,
  onPrioritise,
  onPrioritiseWeekly,
  onStopBurst,
}: QuotaAccountRowProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const detailId = useId();
  const name = getAccountLabel(entry.file);
  const plan = getPlanLabel(t, entry, quota, livePlanType);
  const loading = status.kind === 'loading';

  const statusText = (() => {
    switch (status.kind) {
      case 'exhausted':
        return status.backAtMs === null
          ? t('quota_management.row_exhausted')
          : t('quota_management.row_back', {
              relative: formatRelativeInstant(status.backAtMs, now, locale),
            });
      case 'logged_out':
        return t('quota_management.row_logged_out');
      case 'error':
        return t('quota_management.row_error');
      case 'disabled':
        return t('quota_management.row_disabled');
      default:
        return null;
    }
  })();

  const statusTone =
    status.kind === 'exhausted'
      ? styles.statusWarn
      : status.kind === 'logged_out' || status.kind === 'error'
        ? styles.statusBad
        : styles.statusMuted;

  const dotClass =
    status.kind === 'ok'
      ? styles.dotOk
      : status.kind === 'exhausted'
        ? styles.dotWarn
        : status.kind === 'logged_out' || status.kind === 'error'
          ? styles.dotBad
          : styles.dotIdle;

  const burstTime = burst ? formatBurstEndShort(burst, now, locale) : '';
  const burstText = burst
    ? t(
        burst.kind === 'weekly'
          ? 'quota_management.burst_tag_weekly'
          : 'quota_management.burst_tag',
        {
          rank: burst.rank,
          time: formatBurstEnd(burst.endsAtMs, locale, undefined, burst.kind === 'weekly'),
        }
      )
    : null;

  const errorMessage =
    status.kind === 'error'
      ? resolveQuotaErrorMessage(t, status.status, status.message || t('common.unknown_error'))
      : null;

  return (
    <div className={`${styles.item} ${status.kind === 'disabled' ? styles.itemDisabled : ''}`}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.identity}
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
          title={name === entry.file.name ? name : `${name}\n${entry.file.name}`}
        >
          <IconChevronDown
            size={14}
            aria-hidden="true"
            className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
          />
          <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
          <span className={styles.name}>{name}</span>
          {plan && <span className={styles.plan}>{plan}</span>}
        </button>

        <div className={styles.limits} aria-busy={loading || undefined}>
          {loading && limits.length === 0 ? (
            <>
              <span className={styles.skeleton} />
              <span className={styles.skeleton} />
            </>
          ) : status.kind === 'logged_out' ? (
            <span className={styles.message}>{t('quota_management.row_logged_out_hint')}</span>
          ) : errorMessage ? (
            <span className={styles.message} title={errorMessage}>
              {errorMessage}
            </span>
          ) : (
            limits.map((limit) => (
              <LimitCell key={limit.id} limit={limit} now={now} locale={locale} />
            ))
          )}
        </div>

        <div className={`${styles.status} ${statusTone}`}>
          {statusText && (
            <span className={styles.statusText} title={statusText}>
              {statusText}
            </span>
          )}
          {burst ? (
            <span className={styles.burstPill} title={burstText ?? undefined}>
              {burst.kind === 'weekly' && (
                <IconChevronsUp size={11} aria-hidden="true" className={styles.pillMark} />
              )}
              <span aria-hidden="true">
                {t('quota_management.burst_short', { rank: burst.rank, time: burstTime })}
              </span>
              <span className={styles.srOnly}>{burstText}</span>
              {onStopBurst && (
                <button
                  type="button"
                  className={styles.burstStop}
                  onClick={onStopBurst}
                  disabled={!canRefresh || burstPending}
                  aria-busy={burstPending || undefined}
                  aria-label={t('quota_management.burst_stop')}
                  title={t('quota_management.burst_stop_hint')}
                >
                  <IconX size={10} aria-hidden="true" />
                </button>
              )}
            </span>
          ) : (
            <>
              {statusText ? null : canPrioritise && onPrioritise ? (
                <button
                  type="button"
                  className={`${styles.rowAction} ${styles.rowActionIcon}`}
                  onClick={onPrioritise}
                  disabled={!canRefresh || burstPending}
                  aria-busy={burstPending || undefined}
                  aria-label={t('quota_management.burst_prioritise')}
                  title={t('quota_management.burst_hint')}
                >
                  <IconChevronUp size={14} aria-hidden="true" />
                </button>
              ) : (
                canStartWindow &&
                onStartWindow && (
                  <button
                    type="button"
                    className={styles.rowAction}
                    onClick={onStartWindow}
                    disabled={!canRefresh || startingWindow}
                    title={t('quota_management.start_window_hint')}
                  >
                    <IconTimer size={12} aria-hidden="true" />
                    {startingWindow
                      ? t('quota_management.start_window_running')
                      : t('quota_management.start_window')}
                  </button>
                )
              )}
              {canPrioritiseWeekly && onPrioritiseWeekly && (
                <button
                  type="button"
                  className={`${styles.rowAction} ${styles.rowActionIcon}`}
                  onClick={onPrioritiseWeekly}
                  disabled={!canRefresh || burstPending}
                  aria-busy={burstPending || undefined}
                  aria-label={t('quota_management.burst_prioritise_weekly')}
                  title={t('quota_management.burst_hint_weekly')}
                >
                  <IconChevronsUp size={14} aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          className={styles.refresh}
          onClick={onRefresh}
          disabled={!canRefresh || loading || resetting}
          aria-label={t('auth_files.quota_refresh_single')}
          title={t('auth_files.quota_refresh_single')}
        >
          <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />
        </button>
      </div>

      {expanded && (
        <div id={detailId} className={styles.detail}>
          <QuotaCard
            entry={entry}
            quota={quota}
            resolvedTheme={resolvedTheme}
            canRefresh={canRefresh}
            resetting={resetting}
            embedded
            onRefresh={onRefresh}
            onReset={onReset}
          />
        </div>
      )}
    </div>
  );
}
