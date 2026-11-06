import type { CSSProperties } from 'react';
import {
  getOpenAIProviderTotalStats,
  getProviderTotalStats,
  getProviderUsageKey,
  type ProviderRecentUsageMap,
} from '@/components/providers/utils';
import type { OpenAIProviderConfig, ResolvedTheme } from '@/types';
import { PROVIDER_LOGOS } from '../brandLogos';
import { isMultiProtocolSponsorBrand } from '../sponsorDefinitions';
import type { ProviderBrand, ProviderResource } from '../types';

/** Display helpers shared by the provider group, row and detail components. */

export const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com';

export function getResourceLabel(resource: ProviderResource): string {
  if (resource.brand === 'openaiCompatibility' || isMultiProtocolSponsorBrand(resource.brand)) {
    return resource.name ?? resource.identifier;
  }
  return resource.apiKeyPreview ?? resource.name ?? resource.identifier;
}

export function getResourceTotalStats(
  resource: ProviderResource,
  usageByProvider: ProviderRecentUsageMap
): { success: number; failure: number } | null {
  if (isMultiProtocolSponsorBrand(resource.brand)) return null;
  if (resource.brand === 'openaiCompatibility') {
    return getOpenAIProviderTotalStats(resource.raw as OpenAIProviderConfig, usageByProvider);
  }
  return getProviderTotalStats(
    usageByProvider,
    getProviderUsageKey(resource.brand),
    resource.apiKey ?? undefined,
    resource.baseUrl ?? undefined
  );
}

export function getBrandLogoSrc(brand: ProviderBrand, resolvedTheme: ResolvedTheme): string | null {
  const logo = PROVIDER_LOGOS[brand];
  if (!logo) return null;
  return resolvedTheme === 'dark' && logo.darkSrc ? logo.darkSrc : logo.src;
}

/** Theme-surface logos sit on an inverted well that follows the theme. */
export function getBrandLogoWellStyle(brand: ProviderBrand): CSSProperties | undefined {
  return PROVIDER_LOGOS[brand]?.themeSurface ? { background: 'var(--text-primary)' } : undefined;
}
