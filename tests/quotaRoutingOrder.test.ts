import { describe, expect, test } from 'bun:test';
import {
  routingOrder,
  shortAccountName,
  type RoutingOrderInput,
} from '../src/features/quota/routingOrder';

const account = (
  name: string,
  priority: number,
  extra: Partial<RoutingOrderInput> = {}
): RoutingOrderInput => ({
  authIndex: name,
  name,
  priority,
  disabled: false,
  status: { kind: 'ok' },
  coolingDown: false,
  burst: null,
  ...extra,
});

const names = (steps: ReturnType<typeof routingOrder>) => steps.map((step) => step.name);
const inUse = (steps: ReturnType<typeof routingOrder>) =>
  steps.filter((step) => step.inUse).map((step) => step.name);

describe('routingOrder', () => {
  test('orders by priority and marks the top ready account in use', () => {
    const steps = routingOrder([
      account('rishit', 80),
      account('dev', 92),
      account('code', 82),
      account('backend', 0),
      account('admin', 84),
    ]);
    expect(names(steps)).toEqual(['dev', 'admin', 'code', 'rishit', 'backend']);
    expect(inUse(steps)).toEqual(['dev']);
  });

  test('skips accounts that cannot serve', () => {
    const steps = routingOrder([
      account('dev', 92, { status: { kind: 'exhausted', backAtMs: null } }),
      account('admin', 84, { coolingDown: true }),
      account('code', 82),
    ]);
    expect(inUse(steps)).toEqual(['code']);
    expect(steps.find((step) => step.name === 'admin')?.ready).toBe(false);
  });

  test('equal priorities share the traffic', () => {
    const steps = routingOrder([account('a', 50), account('b', 50), account('c', 10)]);
    expect(inUse(steps)).toEqual(['a', 'b']);
  });

  test('prioritised accounts come first in burst order and are used alone', () => {
    const steps = routingOrder([
      account('dev', 92),
      account('rishit', 80, { burst: { rank: 2, endsAtMs: 2, kind: '5h' } }),
      account('admin', 84, { burst: { rank: 1, endsAtMs: 1, kind: '5h' } }),
    ]);
    expect(names(steps)).toEqual(['admin', 'rishit', 'dev']);
    expect(inUse(steps)).toEqual(['admin']);
  });

  test('an exhausted prioritised account falls through to the next one', () => {
    const steps = routingOrder([
      account('dev', 92),
      account('admin', 84, { burst: { rank: 1, endsAtMs: 1, kind: '5h' }, coolingDown: true }),
      account('rishit', 80, { burst: { rank: 2, endsAtMs: 2, kind: '5h' } }),
    ]);
    expect(inUse(steps)).toEqual(['rishit']);
  });

  test('disabled accounts are left out', () => {
    const steps = routingOrder([account('a', 10, { disabled: true }), account('b', 0)]);
    expect(names(steps)).toEqual(['b']);
    expect(inUse(steps)).toEqual(['b']);
  });

  test('nothing is in use when no account can serve', () => {
    const steps = routingOrder([account('a', 10, { coolingDown: true })]);
    expect(inUse(steps)).toEqual([]);
  });
});

describe('shortAccountName', () => {
  test('keeps the part before @', () => {
    expect(shortAccountName('admin@example.com')).toBe('admin');
    expect(shortAccountName('codex-plus.json')).toBe('codex-plus.json');
  });
});
