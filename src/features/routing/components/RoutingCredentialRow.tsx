/**
 * One pooled credential: identity (state dot, account, plan chip), priority,
 * optional weight, live state with cooldown reset, excluded-models count, and
 * an enable toggle that applies immediately. Expanding opens the per-credential
 * excluded-models editor (lazy-loaded from the credential file).
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ExpandableRow, groupedRowStyles as g } from '@/components/common/GroupedRows';
import { IconRefreshCw } from '@/components/ui/icons';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { AuthFileExcludedModelsField } from '@/features/authFiles/components/AuthFileExcludedModelsField';
import { resolvePlanTier } from '@/utils/quota/planTier';
import {
  credentialState,
  normalizeExcludedModels,
  savedWeightText,
  type CredentialDraft,
  type CredentialFieldErrors,
  type CredentialState,
  type ExcludedBaseline,
  type RoutingCredential,
} from '../logic';
import { getPlanLabel, stateText } from '../labels';
import { DenseInput } from './DenseInput';
import styles from './Routing.module.scss';

export type ExcludedLoadState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; baseline: ExcludedBaseline };

export type CredentialRowHandlers = {
  onToggleExpand: (credential: RoutingCredential) => void;
  onPriority: (credential: RoutingCredential, text: string) => void;
  onWeight: (credential: RoutingCredential, text: string) => void;
  onExcluded: (credential: RoutingCredential, text: string) => void;
  onRetryExcluded: (credential: RoutingCredential) => void;
  onEnable: (credential: RoutingCredential, enabled: boolean) => void;
  onResetCooldown: (credential: RoutingCredential) => void;
};

export type RoutingCredentialRowProps = {
  credential: RoutingCredential;
  draft?: CredentialDraft;
  errors?: CredentialFieldErrors;
  weighted: boolean;
  nowMs: number;
  expanded: boolean;
  excluded?: ExcludedLoadState;
  disabled: boolean;
  toggling: boolean;
  resetting: boolean;
  handlers: CredentialRowHandlers;
};

const DOT_CLASS: Record<CredentialState['kind'], string> = {
  ready: g.dotOk,
  cooling: g.dotWarn,
  off: '',
  unknown: '',
};

const ROW_STYLE = {
  '--row-identity': '300px',
  '--row-cols': 'minmax(0, 1fr)',
} as CSSProperties;

export function RoutingCredentialRow({
  credential,
  draft,
  errors,
  weighted,
  nowMs,
  expanded,
  excluded,
  disabled,
  toggling,
  resetting,
  handlers,
}: RoutingCredentialRowProps) {
  const { t } = useTranslation();
  const state = credentialState(credential, nowMs);
  const plan = getPlanLabel(t, credential);
  const planTier = credential.provider === 'codex' ? resolvePlanTier(credential.planType) : 'plain';
  const editDisabled = disabled || !credential.editable;
  const baseline = excluded?.status === 'ready' ? excluded.baseline : undefined;
  const excludedCount =
    draft?.excludedText !== undefined
      ? normalizeExcludedModels(draft.excludedText).length
      : baseline?.models.length;
  const errorText = (key: 'priority' | 'weight') =>
    errors?.[key] ? t(`routing.error_${errors[key]}`) : null;

  const detail = (
    <div className={styles.detail}>
      <div className={styles.detailMeta}>
        <span className={g.muted}>{t('routing.file')}</span>
        <span className={`${g.mono} ${g.ellipsis}`}>{credential.name}</span>
        {credential.authIndex && (
          <>
            <span className={g.muted}>{t('routing.auth_index')}</span>
            <span className={g.mono}>{credential.authIndex}</span>
          </>
        )}
      </div>
      {!credential.editable && <p className={styles.detailNote}>{t('routing.read_only')}</p>}
      {credential.editable &&
        (excluded?.status === 'ready' ? (
          <AuthFileExcludedModelsField
            fileName={credential.name}
            value={draft?.excludedText ?? excluded.baseline.models.join('\n')}
            disabled={editDisabled}
            onChange={(text) => handlers.onExcluded(credential, text)}
          />
        ) : excluded?.status === 'error' ? (
          <p className={styles.detailNote} role="alert">
            {t('routing.excluded_load_failed')}{' '}
            <button
              type="button"
              className={g.textButton}
              onClick={() => handlers.onRetryExcluded(credential)}
            >
              {t('routing.retry_load')}
            </button>
          </p>
        ) : (
          <p className={styles.detailNote} aria-busy="true">
            {t('routing.excluded_loading')}
          </p>
        ))}
    </div>
  );

  return (
    <ExpandableRow
      expanded={expanded}
      onToggle={() => handlers.onToggleExpand(credential)}
      identityTitle={credential.name}
      dimmed={credential.disabled}
      style={ROW_STYLE}
      identity={
        <>
          <span className={`${g.dot} ${DOT_CLASS[state.kind]}`} aria-hidden="true" />
          <span className={`${styles.account} ${g.ellipsis}`}>{credential.label}</span>
          {plan && (
            <span
              className={`${g.chip} ${planTier === 'plain' ? '' : styles.chipStrong}`}
              title={t('routing.plan')}
            >
              {plan}
            </span>
          )}
        </>
      }
      trailing={
        <ToggleSwitch
          checked={!credential.disabled}
          disabled={disabled || toggling}
          ariaLabel={t('routing.enable_aria', { name: credential.label })}
          onChange={(enabled) => handlers.onEnable(credential, enabled)}
        />
      }
      detail={detail}
    >
      <div className={`${styles.cells} ${weighted ? styles.cellsWeighted : ''}`}>
        <span className={draft?.priority !== undefined ? styles.dirty : undefined}>
          <DenseInput
            label={t('routing.priority_aria', { name: credential.label })}
            hideLabel
            numeric
            size={4}
            value={draft?.priority ?? String(credential.priority)}
            disabled={editDisabled}
            error={errorText('priority')}
            onCommit={(text) => handlers.onPriority(credential, text)}
          />
        </span>
        {weighted && (
          <span className={draft?.weight !== undefined ? styles.dirty : undefined}>
            <DenseInput
              label={t('routing.weight_aria', { name: credential.label })}
              hideLabel
              numeric
              size={5}
              placeholder="1"
              value={draft?.weight ?? savedWeightText(credential)}
              disabled={editDisabled}
              error={errorText('weight')}
              onChange={(text) => handlers.onWeight(credential, text)}
            />
          </span>
        )}
        <span className={styles.state}>
          <span
            className={
              state.kind === 'cooling'
                ? styles.stateWarn
                : state.kind === 'ready'
                  ? styles.stateOk
                  : g.muted
            }
          >
            {stateText(t, state)}
          </span>
          {state.kind === 'cooling' && credential.authIndex && (
            <button
              type="button"
              className={g.iconButton}
              disabled={disabled || resetting}
              onClick={() => handlers.onResetCooldown(credential)}
              aria-label={t('routing.reset_cooldown_aria', { name: credential.label })}
              title={t('routing.reset_cooldown')}
            >
              <IconRefreshCw size={13} aria-hidden="true" />
            </button>
          )}
        </span>
        <button
          type="button"
          className={`${styles.excludedButton} ${draft?.excludedText !== undefined ? styles.dirty : ''}`}
          aria-expanded={expanded}
          aria-label={
            excludedCount === undefined
              ? t('routing.excluded_aria_unknown', { name: credential.label })
              : t('routing.excluded_aria', { name: credential.label, count: excludedCount })
          }
          onClick={() => handlers.onToggleExpand(credential)}
        >
          <span className={g.muted}>{t('routing.excluded')}</span>
          <span className={g.mono}>{excludedCount ?? '·'}</span>
        </button>
      </div>
    </ExpandableRow>
  );
}
