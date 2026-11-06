import type { TFunction } from 'i18next';
import { normalizePlanType, PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota';

/** Human plan name for a Codex plan type; shared by the detail body and the row chip. */
export function getCodexPlanLabel(t: TFunction, planType?: string | null): string | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'self_serve_business_prolite') {
    return t('codex_quota.plan_business_premium');
  }
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  // Unknown single-word plans (e.g. "go") read better capitalised; compound
  // identifiers stay verbatim so they can still be recognised.
  if (/^[a-z]+$/.test(normalized)) return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return planType || normalized;
}
