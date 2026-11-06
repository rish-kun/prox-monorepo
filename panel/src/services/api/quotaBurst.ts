/**
 * "Prioritise plan" bursts (`/quota/burst`): Claude / Codex accounts routed
 * before every normal priority until their current 5-hour window (kind "5h")
 * or weekly window (kind "weekly") resets or is used up.
 *
 * Every call returns the full burst list. Field names are normalised here and
 * every field is read defensively: a burst without an auth index or a usable
 * end instant is dropped instead of throwing.
 */

import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';
import { readInstantMs } from './quotaSnapshots';

export const QUOTA_BURST_PATH = '/quota/burst';

/** "5h" ends with the current 5-hour window; "weekly" with the weekly window. */
export type QuotaBurstKind = '5h' | 'weekly';

export interface QuotaBurst {
  authIndex: string;
  provider: string;
  label: string;
  startedAtMs: number | null;
  /** The window reset the burst ends at, epoch ms. */
  endsAtMs: number;
  /** 1-based routing order across all bursts. */
  order: number;
  kind: QuotaBurstKind;
}

const readText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const readOrder = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : null;
};

export function normalizeQuotaBurst(raw: unknown, position = 0): QuotaBurst | null {
  if (!isRecord(raw)) return null;
  const authIndex = readText(raw.auth_index ?? raw.authIndex);
  const endsAtMs = readInstantMs(raw.ends_at ?? raw.endsAt);
  if (!authIndex || endsAtMs === null) return null;
  return {
    authIndex,
    provider: readText(raw.provider).toLowerCase(),
    label: readText(raw.label),
    startedAtMs: readInstantMs(raw.started_at ?? raw.startedAt),
    endsAtMs,
    order: readOrder(raw.order) ?? position + 1,
    // Proxies from before weekly bursts send no kind: those are 5-hour bursts.
    kind: readText(raw.kind).toLowerCase() === 'weekly' ? 'weekly' : '5h',
  };
}

/** `{bursts: [...]}` (or a bare array) → bursts in routing order, one per auth index. */
export function normalizeQuotaBurstList(raw: unknown): QuotaBurst[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.bursts : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list
    .map((item, position) => normalizeQuotaBurst(item, position))
    .filter((burst): burst is QuotaBurst => burst !== null)
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.endsAtMs - right.endsAtMs ||
        left.authIndex.localeCompare(right.authIndex)
    )
    .filter((burst) => {
      if (seen.has(burst.authIndex)) return false;
      seen.add(burst.authIndex);
      return true;
    });
}

export const quotaBurstApi = {
  async list(): Promise<QuotaBurst[]> {
    return normalizeQuotaBurstList(await apiClient.get<unknown>(QUOTA_BURST_PATH));
  },

  /**
   * Route this account first until its current 5-hour (default) or weekly
   * window resets or is used up. 409 explains why not.
   */
  async prioritise(authIndex: string, kind: QuotaBurstKind = '5h'): Promise<QuotaBurst[]> {
    const body = kind === 'weekly' ? { auth_index: authIndex, kind } : { auth_index: authIndex };
    return normalizeQuotaBurstList(await apiClient.post<unknown>(QUOTA_BURST_PATH, body));
  },

  async cancel(authIndex: string): Promise<QuotaBurst[]> {
    return normalizeQuotaBurstList(
      await apiClient.delete<unknown>(QUOTA_BURST_PATH, { params: { auth_index: authIndex } })
    );
  },
};
