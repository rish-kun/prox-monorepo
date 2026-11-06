/**
 * Reading a proxy quota snapshot (Claude / Codex) the way the adapters used to
 * read their own `api-call` results. React-free; shared by the provider
 * data modules and tests.
 */

import {
  getApiCallErrorMessage,
  quotaSnapshotsApi,
  type QuotaSnapshot,
  type QuotaSnapshotResponse,
} from '@/services/api';
import { createStatusError } from '@/utils/quota';

const isOkStatus = (status: number) => status >= 200 && status < 300;

export const isOkResponse = (
  response: QuotaSnapshotResponse | undefined
): response is QuotaSnapshotResponse => response !== undefined && isOkStatus(response.statusCode);

/** Same message the old `api-call` path produced for a failed upstream response. */
export const snapshotResponseError = (response: QuotaSnapshotResponse): string =>
  getApiCallErrorMessage({ ...response, header: {} });

/**
 * The last attempt failed after the last success. A non-forced refresh inside
 * the proxy's 60 s window returns the saved snapshot, error included, so an
 * error older than the last successful fetch is history, not state.
 */
export const hasCurrentError = (snapshot: QuotaSnapshot): boolean => {
  if (!snapshot.error && snapshot.errorStatus === null) return false;
  if (snapshot.fetchedAtMs === null || snapshot.attemptedAtMs === null) return true;
  return snapshot.attemptedAtMs > snapshot.fetchedAtMs;
};

/** The credential needs attention (signed out / forbidden): stale numbers would mislead. */
const isAuthFailure = (status: number | null) => status === 401 || status === 403;

/**
 * The snapshot's successful `usage` response, or throws the error the row
 * should show. A failed poll keeps the last good responses: those stay on
 * screen (rate limits and outages say nothing about the account) unless the
 * failure was an authentication one.
 */
export function requireSnapshotUsage(
  snapshot: QuotaSnapshot,
  emptyMessage: string
): QuotaSnapshotResponse {
  const usage = snapshot.responses.usage;
  const failed = hasCurrentError(snapshot);
  if (failed && (isAuthFailure(snapshot.errorStatus) || !isOkResponse(usage))) {
    throw createStatusError(
      snapshot.error || `HTTP ${snapshot.errorStatus ?? ''}`.trim(),
      snapshot.errorStatus ?? undefined
    );
  }
  if (!usage) throw new Error(emptyMessage);
  if (!isOkStatus(usage.statusCode)) {
    throw createStatusError(snapshotResponseError(usage), usage.statusCode);
  }
  return usage;
}

/** True when the snapshot holds anything worth showing (a fetch happened at least once). */
export const snapshotHasContent = (snapshot: QuotaSnapshot): boolean =>
  Object.keys(snapshot.responses).length > 0 || hasCurrentError(snapshot);

/** Ask the proxy to refresh one credential and return its snapshot. */
export async function refreshSnapshotFor(
  authIndex: string,
  options: { force?: boolean } = {}
): Promise<QuotaSnapshot> {
  const result = await quotaSnapshotsApi.refresh([authIndex], options);
  const snapshot = result.snapshots[authIndex];
  if (!snapshot) throw new Error(`No quota snapshot for ${authIndex}`);
  return snapshot;
}
