/**
 * One provider entry as a dense expandable row:
 * identity | base URL · prefix · counts · ✓/✗ · status | enable toggle.
 * Expanding shows the full entry inline with Edit / Delete.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExpandableRow, groupedRowStyles as g } from '@/components/common/GroupedRows';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { ProviderRecentUsageMap } from '@/components/providers/utils';
import { isMultiProtocolSponsorBrand } from '../sponsorDefinitions';
import type { ProviderResource } from '../types';
import { ProviderResourceDetail } from './ProviderResourceDetail';
import {
  CLAUDE_DEFAULT_BASE_URL,
  getResourceLabel,
  getResourceTotalStats,
} from './providerDisplay';
import styles from './ProviderResourceRow.module.scss';

const ROW_STYLE = {
  '--row-identity': '300px',
  '--row-cols': 'minmax(0, 1fr)',
} as CSSProperties;

export type ProviderResourceRowProps = {
  resource: ProviderResource;
  usageByProvider?: ProviderRecentUsageMap;
  expanded: boolean;
  disableMutations: boolean;
  onToggleExpanded: () => void;
  onToggleDisabled: (resource: ProviderResource, disabled: boolean) => void;
  onEdit: (resource: ProviderResource) => void;
  onDelete: (resource: ProviderResource) => void;
};

export function ProviderResourceRow({
  resource,
  usageByProvider,
  expanded,
  disableMutations,
  onToggleExpanded,
  onToggleDisabled,
  onEdit,
  onDelete,
}: ProviderResourceRowProps) {
  const { t } = useTranslation();
  const label = getResourceLabel(resource);
  const isSponsor = isMultiProtocolSponsorBrand(resource.brand);
  const extraKeys =
    resource.brand === 'openaiCompatibility' && resource.apiKeyEntryCount > 1
      ? resource.apiKeyEntryCount - 1
      : 0;
  const stats = usageByProvider ? getResourceTotalStats(resource, usageByProvider) : null;

  const counts: Array<{ key: string; label: string; value: number }> = [
    { key: 'models', label: t('providersPage.table.metrics.models'), value: resource.modelCount },
  ];
  if (resource.headerCount > 0) {
    counts.push({
      key: 'headers',
      label: t('providersPage.table.metrics.headers'),
      value: resource.headerCount,
    });
  }
  if ((resource.brand === 'openaiCompatibility' || isSponsor) && resource.apiKeyEntryCount > 0) {
    counts.push({
      key: 'keys',
      label: t('providersPage.table.metrics.keys'),
      value: resource.apiKeyEntryCount,
    });
  }

  const tags: string[] = [];
  if (resource.flags.websockets) tags.push(t('providersPage.table.websocketsTag'));
  if (resource.flags.cloakEnabled) tags.push(t('providersPage.table.cloakTag'));
  if (resource.flags.claudeCodeCliProfile) tags.push(t('providersPage.table.cliProfileTag'));

  let baseUrl: ReactNode;
  if (resource.baseUrl) {
    baseUrl = resource.baseUrl;
  } else if (resource.brand === 'claude') {
    baseUrl = (
      <>
        {CLAUDE_DEFAULT_BASE_URL}{' '}
        <span className={g.muted}>{t('providersPage.status.defaultSuffix')}</span>
      </>
    );
  } else {
    baseUrl = <span className={g.muted}>—</span>;
  }
  const baseUrlTitle =
    resource.baseUrl ?? (resource.brand === 'claude' ? CLAUDE_DEFAULT_BASE_URL : undefined);

  return (
    <ExpandableRow
      expanded={expanded}
      onToggle={onToggleExpanded}
      identityTitle={label}
      dimmed={resource.disabled}
      style={ROW_STYLE}
      identity={
        <>
          <span className={`${g.dot} ${resource.disabled ? '' : g.dotOk}`} aria-hidden="true" />
          <span className={`${g.ellipsis} ${styles.name}`}>{label}</span>
          {extraKeys > 0 && (
            <span className={g.chip}>{t('providersPage.row.moreKeys', { count: extraKeys })}</span>
          )}
        </>
      }
      trailing={
        <ToggleSwitch
          checked={!resource.disabled}
          disabled={disableMutations}
          onChange={(value) => onToggleDisabled(resource, !value)}
          ariaLabel={t('providersPage.row.toggle', { name: label })}
        />
      }
      detail={
        <ProviderResourceDetail
          resource={resource}
          usageByProvider={usageByProvider}
          disableMutations={disableMutations}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      }
    >
      <div className={styles.cells}>
        <span className={`${g.mono} ${g.ellipsis} ${styles.url}`} title={baseUrlTitle}>
          {baseUrl}
        </span>
        <span className={styles.prefix}>
          {resource.prefix ? (
            <span className={`${g.chip} ${styles.prefixChip}`} title={resource.prefix}>
              {resource.prefix}
            </span>
          ) : null}
        </span>
        <span className={styles.counts}>
          {counts.map((item) => (
            <span key={item.key} className={styles.count}>
              <span className={g.muted}>{item.label}</span>
              <span className={g.mono}>{item.value}</span>
            </span>
          ))}
          {tags.map((tag) => (
            <span key={tag} className={g.chip}>
              {tag}
            </span>
          ))}
        </span>
        <span
          className={`${g.mono} ${styles.stats}`}
          title={
            stats
              ? t('providersPage.row.stats', { success: stats.success, failure: stats.failure })
              : undefined
          }
        >
          {stats ? (
            <>
              <span className={styles.srOnly}>
                {t('providersPage.row.stats', { success: stats.success, failure: stats.failure })}
              </span>
              <span className={styles.success} aria-hidden="true">
                ✓{stats.success}
              </span>
              <span className={stats.failure > 0 ? styles.failure : g.muted} aria-hidden="true">
                ✗{stats.failure}
              </span>
            </>
          ) : null}
        </span>
        <span className={styles.status}>
          {resource.disabled ? t('providersPage.status.disabled') : null}
        </span>
      </div>
    </ExpandableRow>
  );
}
