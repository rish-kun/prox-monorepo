/**
 * The order the proxy hands new requests to a provider's accounts, as the
 * Quota page shows it under each provider header. Pure functions, no clock;
 * covered by tests/quotaRoutingOrder.test.ts.
 *
 * Mirrors the proxy's scheduler: prioritised ("burst") accounts first in burst
 * order, then the highest routing priority. The first account that can serve
 * gets the traffic; accounts sharing a normal priority take turns, so all of
 * them are "in use" together. A prioritised account is always used alone.
 */

import type { QuotaRowStatus } from './quotaRowSummary';
import type { RowBurst } from './quotaBurst';

export interface RoutingOrderInput {
  authIndex: string | null;
  name: string;
  /** Routing priority from the credential; 0 when unset. */
  priority: number;
  disabled: boolean;
  status: QuotaRowStatus;
  /** The proxy currently holds a cooldown for this account. */
  coolingDown: boolean;
  burst: RowBurst | null;
}

export interface RoutingStep {
  authIndex: string | null;
  name: string;
  priority: number;
  burst: RowBurst | null;
  /** Could take a request right now. */
  ready: boolean;
  /** Receives new requests right now. */
  inUse: boolean;
}

const NOT_SERVING: ReadonlySet<QuotaRowStatus['kind']> = new Set([
  'disabled',
  'exhausted',
  'logged_out',
  'error',
]);

/** Accounts with no loaded quota (idle/loading) count as ready, as the proxy sees them. */
export function isRoutingReady(input: RoutingOrderInput): boolean {
  return !input.disabled && !input.coolingDown && !NOT_SERVING.has(input.status.kind);
}

export function routingOrder(inputs: readonly RoutingOrderInput[]): RoutingStep[] {
  const steps: RoutingStep[] = inputs
    .filter((input) => !input.disabled)
    .map((input) => ({
      authIndex: input.authIndex,
      name: input.name,
      priority: input.priority,
      burst: input.burst,
      ready: isRoutingReady(input),
      inUse: false,
    }))
    .sort(
      (left, right) =>
        (left.burst ? left.burst.rank : Infinity) - (right.burst ? right.burst.rank : Infinity) ||
        right.priority - left.priority ||
        left.name.localeCompare(right.name)
    );

  const first = steps.find((step) => step.ready);
  if (!first) return steps;
  if (first.burst) {
    first.inUse = true;
    return steps;
  }
  for (const step of steps) {
    if (step.ready && !step.burst && step.priority === first.priority) step.inUse = true;
  }
  return steps;
}

/** "admin@example.com" → "admin"; non-email names are kept. */
export function shortAccountName(name: string): string {
  const at = name.indexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}
