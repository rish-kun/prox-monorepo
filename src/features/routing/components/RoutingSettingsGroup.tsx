/**
 * Global routing policy as one bordered group of dense setting rows:
 * strategy · sticky sessions · retry · cooldown · per-model cooling.
 */

import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RowGroup } from '@/components/common/GroupedRows';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  ROUTING_STRATEGIES,
  type RoutingFieldError,
  type RoutingSettingKey,
  type RoutingSettings,
} from '../logic';
import { STRATEGY_LABEL_KEYS } from '../labels';
import { DenseInput } from './DenseInput';
import styles from './Routing.module.scss';

export type RoutingSettingsGroupProps = {
  settings: RoutingSettings;
  errors: Partial<Record<RoutingSettingKey, RoutingFieldError>>;
  disabled: boolean;
  stickyNote: boolean;
  onChange: (patch: Partial<RoutingSettings>) => void;
};

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className={styles.settingRow} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.settingLabel}>
        {label}
      </span>
      <div className={styles.settingControls}>{children}</div>
    </div>
  );
}

export function RoutingSettingsGroup({
  settings,
  errors,
  disabled,
  stickyNote,
  onChange,
}: RoutingSettingsGroupProps) {
  const { t } = useTranslation();
  const radioName = useId();
  const errorText = (key: RoutingSettingKey) =>
    errors[key] ? t(`routing.error_${errors[key]}`) : null;
  const stickyOff = !settings.sessionAffinity;

  return (
    <RowGroup label={t('routing.policy_title')} title={t('routing.policy_title')}>
      <SettingRow label={t('routing.strategy')}>
        <div className={styles.segmented} role="radiogroup" aria-label={t('routing.strategy')}>
          {ROUTING_STRATEGIES.map((strategy) => (
            <label key={strategy} className={styles.segment}>
              <input
                type="radio"
                name={radioName}
                value={strategy}
                checked={settings.strategy === strategy}
                disabled={disabled}
                onChange={() => onChange({ strategy })}
              />
              <span>{t(STRATEGY_LABEL_KEYS[strategy])}</span>
            </label>
          ))}
        </div>
      </SettingRow>

      <SettingRow label={t('routing.sticky')}>
        <ToggleSwitch
          checked={settings.sessionAffinity}
          disabled={disabled}
          onChange={(sessionAffinity) => onChange({ sessionAffinity })}
          label={t('routing.sticky_enabled')}
        />
        <DenseInput
          label={t('routing.sticky_ttl')}
          value={settings.sessionAffinityTTL}
          placeholder="1h"
          size={6}
          disabled={disabled || stickyOff}
          error={errorText('sessionAffinityTTL')}
          onChange={(sessionAffinityTTL) => onChange({ sessionAffinityTTL })}
        />
        <ToggleSwitch
          checked={settings.sessionAffinitySubagents}
          disabled={disabled || stickyOff}
          onChange={(sessionAffinitySubagents) => onChange({ sessionAffinitySubagents })}
          label={t('routing.sticky_subagents')}
        />
      </SettingRow>

      {stickyNote && (
        <p className={styles.note} role="status">
          {t('routing.sticky_reset_note')}
        </p>
      )}

      <SettingRow label={t('routing.retry')}>
        <DenseInput
          label={t('routing.retry_rounds')}
          value={settings.requestRetry}
          placeholder="0"
          numeric
          size={4}
          disabled={disabled}
          error={errorText('requestRetry')}
          onChange={(requestRetry) => onChange({ requestRetry })}
        />
        <DenseInput
          label={t('routing.retry_credentials')}
          value={settings.maxRetryCredentials}
          placeholder="0"
          numeric
          size={4}
          disabled={disabled}
          error={errorText('maxRetryCredentials')}
          onChange={(maxRetryCredentials) => onChange({ maxRetryCredentials })}
        />
        <DenseInput
          label={t('routing.retry_wait')}
          value={settings.maxRetryInterval}
          placeholder="0"
          numeric
          size={5}
          disabled={disabled}
          error={errorText('maxRetryInterval')}
          onChange={(maxRetryInterval) => onChange({ maxRetryInterval })}
        />
      </SettingRow>

      <SettingRow label={t('routing.cooldown')}>
        <ToggleSwitch
          checked={settings.cooling}
          disabled={disabled}
          onChange={(cooling) => onChange({ cooling })}
          label={t('routing.cooling')}
        />
        <ToggleSwitch
          checked={settings.saveCooldownStatus}
          disabled={disabled}
          onChange={(saveCooldownStatus) => onChange({ saveCooldownStatus })}
          label={t('routing.cooldown_persist')}
        />
        <DenseInput
          label={t('routing.cooldown_transient')}
          value={settings.transientErrorCooldownSeconds}
          placeholder="0"
          numeric
          size={5}
          disabled={disabled}
          error={errorText('transientErrorCooldownSeconds')}
          onChange={(transientErrorCooldownSeconds) => onChange({ transientErrorCooldownSeconds })}
        />
      </SettingRow>

      <SettingRow label={t('routing.model_cooling')}>
        <ToggleSwitch
          checked={settings.claudeModelLevelCooling}
          disabled={disabled}
          onChange={(claudeModelLevelCooling) => onChange({ claudeModelLevelCooling })}
          label={t('routing.model_cooling_claude')}
        />
        <ToggleSwitch
          checked={settings.codexModelLevelCooling}
          disabled={disabled}
          onChange={(codexModelLevelCooling) => onChange({ codexModelLevelCooling })}
          label={t('routing.model_cooling_codex')}
        />
      </SettingRow>
    </RowGroup>
  );
}
