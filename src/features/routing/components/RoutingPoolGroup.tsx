/**
 * One provider's credential pool: a capacity header (square per account,
 * ready/total, tier count, Preset menu) and rows grouped into priority tiers,
 * highest first. Only the highest tier with an available credential serves;
 * lower tiers are fallback.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RowGroup, groupedRowStyles as g } from '@/components/common/GroupedRows';
import { IconChevronDown } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import {
  credentialState,
  supportsPlanPreset,
  type CredentialDrafts,
  type CredentialFieldErrors,
  type PriorityTier,
  type RoutingCredential,
} from '../logic';
import {
  RoutingCredentialRow,
  type CredentialRowHandlers,
  type ExcludedLoadState,
} from './RoutingCredentialRow';
import styles from './Routing.module.scss';

export type PresetKind = 'plan' | 'flat' | 'revert';

const SQUARE_CLASS = {
  ready: styles.squareOk,
  cooling: styles.squareWarn,
  off: styles.squareIdle,
  unknown: styles.squareIdle,
} as const;

function PresetMenu({
  provider,
  disabled,
  onPreset,
}: {
  provider: string;
  disabled: boolean;
  onPreset: (kind: PresetKind) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const items: Array<{ kind: PresetKind; label: string; hint: string; disabled?: boolean }> = [
    {
      kind: 'plan',
      label: t('routing.preset_by_plan'),
      hint: t(`routing.preset_by_plan_hint_${provider === 'claude' ? 'claude' : 'codex'}`),
      disabled: !supportsPlanPreset(provider),
    },
    { kind: 'flat', label: t('routing.preset_flat'), hint: t('routing.preset_flat_hint') },
    { kind: 'revert', label: t('routing.preset_revert'), hint: t('routing.preset_revert_hint') },
  ];

  useEffect(() => {
    if (!open) return;
    itemRefs.current.find((item) => item && !item.disabled)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = itemRefs.current.filter(
      (item): item is HTMLButtonElement => !!item && !item.disabled
    );
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(index + step + enabled.length) % enabled.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className={styles.menuRoot} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={g.textButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {t('routing.preset')}
        <IconChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('routing.preset')}
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.kind}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                onPreset(item.kind);
              }}
            >
              <span>{item.label}</span>
              <span className={styles.menuHint}>{item.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TIER_ROLE_KEYS = {
  primary: 'routing.tier_primary',
  fallback: 'routing.tier_fallback',
  off: 'routing.tier_off',
} as const;

export type RoutingPoolGroupProps = {
  provider: string;
  credentials: RoutingCredential[];
  tiers: PriorityTier[];
  drafts: CredentialDrafts;
  errors: Record<string, CredentialFieldErrors>;
  weighted: boolean;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  disabled: boolean;
  expanded: ReadonlySet<string>;
  excluded: Readonly<Record<string, ExcludedLoadState>>;
  busyKeys: ReadonlySet<string>;
  handlers: CredentialRowHandlers;
  onPreset: (kind: PresetKind) => void;
};

export function RoutingPoolGroup({
  provider,
  credentials,
  tiers,
  drafts,
  errors,
  weighted,
  nowMs,
  resolvedTheme,
  disabled,
  expanded,
  excluded,
  busyKeys,
  handlers,
  onPreset,
}: RoutingPoolGroupProps) {
  const { t } = useTranslation();
  const label = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const states = credentials.map((credential) => credentialState(credential, nowMs));
  const ready = states.filter((state) => state.kind === 'ready').length;

  return (
    <RowGroup
      label={label}
      title={label}
      icon={
        iconSrc ? (
          <img src={iconSrc} alt="" />
        ) : (
          <span aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
        )
      }
      iconStyle={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
      summary={
        <>
          <span className={g.squares} aria-hidden="true">
            {states.map((state, index) => (
              <i key={index} className={`${g.square} ${SQUARE_CLASS[state.kind]}`} />
            ))}
          </span>
          <span className={g.mono} title={t('routing.pool_ready', { ready, total: states.length })}>
            {ready}/{states.length}
          </span>
          <span className={g.muted}>{t('routing.pool_tiers', { count: tiers.length })}</span>
        </>
      }
      actions={<PresetMenu provider={provider} disabled={disabled} onPreset={onPreset} />}
    >
      {tiers.map((tier) => (
        <div
          key={tier.priority}
          className={styles.tier}
          role="group"
          aria-label={t('routing.tier_aria', { priority: tier.priority })}
        >
          <div className={styles.tierHead}>
            <span className={g.mono}>P{tier.priority}</span>
            <span
              className={
                tier.role === 'primary'
                  ? styles.stateOk
                  : tier.role === 'off'
                    ? g.muted
                    : styles.tierFallback
              }
            >
              {t(TIER_ROLE_KEYS[tier.role])}
            </span>
            <span className={g.muted}>· {tier.credentials.length}</span>
          </div>
          {tier.credentials.map((credential) => (
            <RoutingCredentialRow
              key={credential.key}
              credential={credential}
              draft={drafts[credential.key]}
              errors={errors[credential.key]}
              weighted={weighted}
              nowMs={nowMs}
              expanded={expanded.has(credential.key)}
              excluded={excluded[credential.key]}
              disabled={disabled}
              toggling={busyKeys.has(`status:${credential.key}`)}
              resetting={busyKeys.has(`reset:${credential.key}`)}
              handlers={handlers}
            />
          ))}
        </div>
      ))}
    </RowGroup>
  );
}
