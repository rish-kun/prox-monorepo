/** Translation helpers shared by the routing components (kept out of .tsx for fast refresh). */

import type { TFunction } from 'i18next';
import { getCodexPlanLabel } from '@/features/quota/providers/codex/planLabel';
import type { CredentialState, RoutingCredential, RoutingStrategy } from './logic';

export const STRATEGY_LABEL_KEYS: Record<RoutingStrategy, string> = {
  'round-robin': 'routing.strategy_round_robin',
  'weighted-round-robin': 'routing.strategy_weighted',
  'fill-first': 'routing.strategy_fill_first',
};

export function formatCooldownTime(t: TFunction, seconds: number): string {
  if (seconds < 60) return t('auth_files.cooldown_seconds', { count: Math.max(0, seconds) });
  if (seconds < 3600) return t('auth_files.cooldown_minutes', { count: Math.ceil(seconds / 60) });
  return t('auth_files.cooldown_hours', { count: Math.ceil(seconds / 3600) });
}

export function getPlanLabel(t: TFunction, credential: RoutingCredential): string | null {
  if (!credential.planType) return null;
  if (credential.provider === 'codex') return getCodexPlanLabel(t, credential.planType);
  if (credential.provider === 'claude') {
    return t(`claude_quota.${credential.planType}`, { defaultValue: credential.planType });
  }
  return credential.planType;
}

export function stateText(t: TFunction, state: CredentialState): string {
  switch (state.kind) {
    case 'off':
      return t('routing.state_off');
    case 'unknown':
      return t('routing.state_unknown');
    case 'cooling':
      return state.scope === 'credential'
        ? t('routing.state_cooling', { time: formatCooldownTime(t, state.seconds) })
        : t('routing.state_cooling_models', {
            count: state.modelCount,
            time: formatCooldownTime(t, state.seconds),
          });
    default:
      return t('routing.state_ready');
  }
}
