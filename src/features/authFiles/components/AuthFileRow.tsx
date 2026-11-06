/**
 * One credential as a dense row inside its provider group.
 *
 * Row: checkbox · identity (dot + account) · filename · note · ✓/✗ counts ·
 * p/w · status (only when actionable) · manual refresh · enable toggle.
 * Expanded: meta, full warning, cooldowns, quota, and the per-file actions.
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ExpandableRow, groupedRowStyles as rowStyles } from '@/components/common/GroupedRows';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import type { AuthFileItem } from '@/types';
import { formatFileSize } from '@/utils/format';
import {
  formatModified,
  getAuthFileStatusMessage,
  summarizeAuthFileStatusMessage,
  hasAuthFileStatusWarning,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { resolveAuthFileQuotaType, type AuthFileHealth } from '@/features/authFiles/logic';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { AuthFileCooldownSection } from './AuthFileCooldownSection';
import { AuthFileQuotaSection } from './AuthFileQuotaSection';
import styles from './AuthFileRow.module.scss';

const ROW_STYLE = {
  '--row-identity': '300px',
  '--row-cols': 'minmax(0, 1fr)',
} as CSSProperties;

const DOT_CLASS: Record<AuthFileHealth['kind'], string> = {
  ok: rowStyles.dotOk,
  cooling: rowStyles.dotWarn,
  problem: rowStyles.dotBad,
  disabled: '',
};

export type AuthFileRowProps = {
  file: AuthFileItem;
  health: AuthFileHealth;
  expanded: boolean;
  selected: boolean;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  cooldownResetting: Record<string, boolean>;
  onToggleExpanded: () => void;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onManualRefresh: (file: AuthFileItem) => void;
  onCooldownReset: (file: AuthFileItem) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
};

export function AuthFileRow(props: AuthFileRowProps) {
  const { t } = useTranslation();
  const {
    file,
    health,
    expanded,
    selected,
    disableControls,
    deleting,
    statusUpdating,
    manualRefreshing,
    cooldownResetting,
    onToggleExpanded,
    onShowModels,
    onDownload,
    onManualRefresh,
    onCooldownReset,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
  } = props;

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const showModelsButton = !isRuntimeOnly || providerKey === 'aistudio';
  const showManualRefreshButton = !isRuntimeOnly && supportsAuthFileManualRefresh(providerKey);
  const isManualRefreshing = manualRefreshing[getAuthFileRefreshKey(file)] === true;
  const isStatusUpdating = statusUpdating[getAuthFileRefreshKey(file)] === true;
  const authIndexKey =
    typeof file.authIndex === 'string' || typeof file.authIndex === 'number'
      ? String(file.authIndex).trim()
      : '';
  const isCooldownResetting = Boolean(authIndexKey && cooldownResetting[authIndexKey]);
  const quotaType = isRuntimeOnly ? null : resolveAuthFileQuotaType(file, 'all');

  const identity = deriveAuthFileIdentity(file);
  const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
  const successCount = file.successCount ?? 0;
  const failureCount = file.failureCount ?? 0;
  const priorityValue = Number.isSafeInteger(file.priority) ? file.priority : undefined;
  const weightValue = Number.isSafeInteger(file.weight) ? file.weight : undefined;
  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning = hasAuthFileStatusWarning(file);

  const cooldownMinutes = (seconds: number) =>
    seconds < 60
      ? t('auth_files.cooldown_seconds', { count: seconds })
      : seconds < 3600
        ? t('auth_files.cooldown_minutes', { count: Math.ceil(seconds / 60) })
        : t('auth_files.cooldown_hours', { count: Math.ceil(seconds / 3600) });

  // Status speaks only when the user can act on it.
  const statusText =
    health.kind === 'disabled'
      ? t('auth_files.health_status_disabled')
      : health.kind === 'problem'
        ? rawStatusMessage && hasStatusWarning
          ? summarizeAuthFileStatusMessage(rawStatusMessage)
          : t('auth_files.row_unavailable')
        : health.kind === 'cooling'
          ? t('auth_files.row_cooling', { time: cooldownMinutes(health.seconds) })
          : '';
  const statusTone =
    health.kind === 'problem'
      ? styles.statusBad
      : health.kind === 'cooling'
        ? styles.statusWarn
        : styles.statusMuted;

  const dim = file.disabled === true ? styles.rowDisabled : '';

  return (
    <ExpandableRow
      expanded={expanded}
      onToggle={onToggleExpanded}
      identityTitle={identity.fullName}
      style={ROW_STYLE}
      leading={
        isRuntimeOnly ? (
          <span className={styles.selectionSpacer} aria-hidden="true" />
        ) : (
          <SelectionCheckbox
            checked={selected}
            onChange={() => onToggleSelect(file.name)}
            ariaLabel={t('auth_files.card_select', { name: file.name })}
            title={t('auth_files.card_select', { name: file.name })}
          />
        )
      }
      identity={
        <span className={`${styles.identity} ${dim}`}>
          <span className={`${rowStyles.dot} ${DOT_CLASS[health.kind]}`} aria-hidden="true" />
          <span
            className={`${rowStyles.ellipsis} ${identity.kind === 'fileName' ? styles.mono : ''}`}
          >
            {identity.primary}
          </span>
          {isRuntimeOnly && (
            <span className={rowStyles.chip} title={t('auth_files.type_virtual')}>
              {t('auth_files.virtual_chip')}
            </span>
          )}
        </span>
      }
      trailing={
        <span className={styles.trailing}>
          {showManualRefreshButton ? (
            <button
              type="button"
              className={rowStyles.iconButton}
              onClick={() => onManualRefresh(file)}
              title={t('auth_files.manual_refresh_button')}
              aria-label={t('auth_files.manual_refresh_button')}
              disabled={disableControls || file.disabled || isStatusUpdating || isManualRefreshing}
            >
              {isManualRefreshing ? <LoadingSpinner size={14} /> : <IconRefreshCw size={14} />}
            </button>
          ) : (
            <span className={styles.trailingSpacer} aria-hidden="true" />
          )}
          {!isRuntimeOnly ? (
            <ToggleSwitch
              ariaLabel={t('auth_files.card_toggle', { name: file.name })}
              checked={!file.disabled}
              disabled={disableControls || isStatusUpdating || isManualRefreshing}
              onChange={(value) => onToggleStatus(file, value)}
            />
          ) : (
            <span className={styles.toggleSpacer} aria-hidden="true" />
          )}
        </span>
      }
      detail={
        <div className={styles.detail}>
          <p className={styles.meta}>
            <span className={styles.metaFile} title={identity.fullName}>
              {identity.fullName}
            </span>
            <span title={t('auth_files.file_size')}>
              {file.size ? formatFileSize(file.size) : '-'}
            </span>
            <span title={t('auth_files.file_modified')}>{formatModified(file)}</span>
            {authIndexKey && (
              <span>
                {t('auth_files.detail_auth_index')} {authIndexKey}
              </span>
            )}
          </p>
          {noteValue && <p className={styles.detailNote}>{noteValue}</p>}
          {rawStatusMessage && hasStatusWarning && (
            <p className={styles.warning}>{rawStatusMessage}</p>
          )}
          <AuthFileCooldownSection
            snapshot={file.cooldownSnapshot}
            resetting={isCooldownResetting}
            resetDisabled={disableControls || isStatusUpdating || isManualRefreshing}
            onReset={authIndexKey ? () => onCooldownReset(file) : undefined}
          />
          {quotaType && (
            <AuthFileQuotaSection
              file={file}
              quotaType={quotaType}
              disableControls={disableControls}
            />
          )}
          <div className={styles.actions}>
            {showModelsButton && (
              <button
                type="button"
                className={rowStyles.textButton}
                onClick={() => onShowModels(file)}
                disabled={disableControls}
              >
                <IconModelCluster size={14} />
                {t('auth_files.models_button')}
              </button>
            )}
            {!isRuntimeOnly && (
              <>
                <button
                  type="button"
                  className={rowStyles.textButton}
                  onClick={() => onDownload(file.name)}
                  disabled={disableControls}
                >
                  <IconDownload size={14} />
                  {t('auth_files.download_button')}
                </button>
                <button
                  type="button"
                  className={rowStyles.textButton}
                  onClick={() => onOpenPrefixProxyEditor(file)}
                  disabled={disableControls || isManualRefreshing}
                  title={t('auth_files.prefix_proxy_button')}
                >
                  <IconSettings size={14} />
                  {t('auth_files.settings_button')}
                </button>
                <button
                  type="button"
                  className={`${rowStyles.textButton} ${rowStyles.danger}`}
                  onClick={() => onDelete(file.name)}
                  disabled={disableControls || deleting === file.name || isManualRefreshing}
                >
                  {deleting === file.name ? <LoadingSpinner size={14} /> : <IconTrash2 size={14} />}
                  {t('auth_files.delete_button')}
                </button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className={`${styles.cells} ${dim}`}>
        <span className={`${styles.fileName} ${rowStyles.ellipsis}`} title={identity.fullName}>
          {identity.secondary ?? ''}
        </span>
        <span className={`${styles.note} ${rowStyles.ellipsis}`} title={noteValue || undefined}>
          {noteValue}
        </span>
        <span className={`${styles.counts} ${rowStyles.mono}`}>
          <span
            className={successCount > 0 ? styles.countOk : rowStyles.muted}
            title={t('stats.success')}
          >
            ✓{successCount}
          </span>
          <span
            className={failureCount > 0 ? styles.countFail : rowStyles.muted}
            title={t('stats.failure')}
          >
            ✗{failureCount}
          </span>
        </span>
        <span className={`${styles.policy} ${rowStyles.mono} ${rowStyles.muted}`}>
          {priorityValue !== undefined && (
            <span title={t('auth_files.priority_hint')}>p{priorityValue}</span>
          )}
          {weightValue !== undefined && (
            <span title={t('auth_files.weight_tooltip')}>w{weightValue}</span>
          )}
        </span>
        <span
          className={`${styles.status} ${statusTone} ${rowStyles.ellipsis}`}
          title={statusText || undefined}
        >
          {statusText}
        </span>
      </div>
    </ExpandableRow>
  );
}
