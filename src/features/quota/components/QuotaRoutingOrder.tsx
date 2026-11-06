/**
 * One line of compact chips under a provider header: the order new requests go
 * to its accounts. The chip(s) receiving traffic right now carry a green dot
 * and tint instead of an "in use" word; unavailable chips are outlined and
 * struck through. Both meanings stay in the chip's title and in visually
 * hidden text for screen readers.
 */

import { useTranslation } from 'react-i18next';
import { IconChevronsUp } from '@/components/ui/icons';
import { formatBurstEnd, formatBurstEndShort } from '../quotaBurst';
import { shortAccountName, type RoutingStep } from '../routingOrder';
import styles from './QuotaRoutingOrder.module.scss';

export type QuotaRoutingOrderProps = {
  steps: RoutingStep[];
  /** Clock for the weekly tags' weekday ("Sat 07:30"). */
  now: number;
};

export function QuotaRoutingOrder({ steps, now }: QuotaRoutingOrderProps) {
  const { t, i18n } = useTranslation();
  if (steps.length === 0) return null;
  const locale = i18n.resolvedLanguage;

  return (
    <div className={styles.routing} title={t('quota_management.routing_hint')}>
      <span className={styles.label}>{t('quota_management.routing_label')}</span>
      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const className = [
            styles.step,
            step.inUse ? styles.inUse : '',
            step.burst ? styles.burst : '',
            step.ready ? '' : styles.blocked,
          ]
            .filter(Boolean)
            .join(' ');
          const weekly = step.burst?.kind === 'weekly';
          const burstTime = step.burst ? formatBurstEndShort(step.burst, now, locale) : '';
          const burstText = step.burst
            ? t(
                weekly ? 'quota_management.routing_burst_weekly' : 'quota_management.routing_burst',
                {
                  rank: step.burst.rank,
                  time: formatBurstEnd(step.burst.endsAtMs, locale, undefined, weekly),
                }
              )
            : null;
          const title = [
            step.name,
            burstText,
            step.inUse ? t('quota_management.routing_in_use_hint') : null,
            step.ready ? null : t('quota_management.routing_unavailable'),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={step.authIndex ?? step.name} className={className}>
              {index > 0 && (
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              )}
              <span className={styles.chip} title={title}>
                {step.inUse && <span className={styles.inUseDot} aria-hidden="true" />}
                {weekly && (
                  <IconChevronsUp size={10} aria-hidden="true" className={styles.chipMark} />
                )}
                <span className={styles.name}>{shortAccountName(step.name)}</span>
                <span className={styles.tag}>
                  {step.burst
                    ? t('quota_management.burst_short', { rank: step.burst.rank, time: burstTime })
                    : t('quota_management.routing_priority', { priority: step.priority })}
                </span>
                {step.inUse && (
                  <span className={styles.srOnly}>{t('quota_management.routing_in_use')}</span>
                )}
                {!step.ready && (
                  <span className={styles.srOnly}>{t('quota_management.routing_unavailable')}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
