/**
 * Routing page pure logic: reading the v8 `routing` subtree into a draftable
 * shape, credential pools and priority tiers, presets, validation, and the
 * draft → (config patch + per-credential patches) diff.
 *
 * No React, no I/O — covered by tests/routingLogic.test.ts.
 */

import { parseRoutingStrategy } from '@/hooks/useVisualConfig';
import type { AuthFileFieldsPatch } from '@/services/api/authFiles';
import type { UpstreamCoolingPatch, UpstreamCoolingState } from '@/services/api/routing';
import type { AuthFileCooldownSnapshot, AuthFileItem } from '@/types/authFile';
import type { RoutingStrategy } from '@/types/visualConfig';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { normalizePlanType, resolveCodexPlanType } from '@/utils/quota';
import { validateCredentialWeightText } from '@/utils/credentialWeight';

export type { RoutingStrategy };

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = [
  'round-robin',
  'weighted-round-robin',
  'fill-first',
];

/** Backend default when `session-affinity-ttl` is empty or unparsable. */
export const DEFAULT_SESSION_AFFINITY_TTL_MS = 60 * 60 * 1000;
export const MIN_SESSION_AFFINITY_TTL_MS = 1000;
export const MAX_PRIORITY = 2_147_483_647;

/* ============================================================
 * Global settings
 * ============================================================ */

export interface RoutingSettings {
  strategy: RoutingStrategy;
  sessionAffinity: boolean;
  /** Go duration text; empty = backend default (1h). */
  sessionAffinityTTL: string;
  sessionAffinitySubagents: boolean;
  /** Integer text; empty = unset (backend default). */
  requestRetry: string;
  maxRetryCredentials: string;
  maxRetryInterval: string;
  /** Inverse of `routing.cooldown.disable-cooling`. */
  cooling: boolean;
  saveCooldownStatus: boolean;
  transientErrorCooldownSeconds: string;
  claudeModelLevelCooling: boolean;
  codexModelLevelCooling: boolean;
}

export type RoutingSettingKey = keyof RoutingSettings;

type SettingKind = 'string' | 'boolean' | 'inverted' | 'integer' | 'duration';

interface SettingSpec {
  key: RoutingSettingKey;
  kind: SettingKind;
  /** Path relative to `routing`, or the upstream provider for model-level cooling. */
  path: readonly string[];
  upstream?: 'claude' | 'codex';
}

export const ROUTING_SETTING_SPECS: readonly SettingSpec[] = [
  { key: 'strategy', kind: 'string', path: ['strategy'] },
  { key: 'sessionAffinity', kind: 'boolean', path: ['session-affinity'] },
  { key: 'sessionAffinityTTL', kind: 'duration', path: ['session-affinity-ttl'] },
  { key: 'sessionAffinitySubagents', kind: 'boolean', path: ['session-affinity-subagents'] },
  { key: 'requestRetry', kind: 'integer', path: ['retry', 'request-retry'] },
  { key: 'maxRetryCredentials', kind: 'integer', path: ['retry', 'max-retry-credentials'] },
  { key: 'maxRetryInterval', kind: 'integer', path: ['retry', 'max-retry-interval'] },
  { key: 'cooling', kind: 'inverted', path: ['cooldown', 'disable-cooling'] },
  { key: 'saveCooldownStatus', kind: 'boolean', path: ['cooldown', 'save-cooldown-status'] },
  {
    key: 'transientErrorCooldownSeconds',
    kind: 'integer',
    path: ['cooldown', 'transient-error-cooldown-seconds'],
  },
  { key: 'claudeModelLevelCooling', kind: 'boolean', path: [], upstream: 'claude' },
  { key: 'codexModelLevelCooling', kind: 'boolean', path: [], upstream: 'codex' },
];

/** Changing any of these rebuilds the backend selector, dropping sticky bindings. */
export const STICKY_SENSITIVE_KEYS: readonly RoutingSettingKey[] = [
  'strategy',
  'sessionAffinity',
  'sessionAffinityTTL',
  'sessionAffinitySubagents',
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readPath = (root: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, key) => asRecord(value)?.[key], root);

const readBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const readText = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';

export function readRoutingSettings(
  routing: unknown,
  upstream: UpstreamCoolingState = { claude: false, codex: false }
): RoutingSettings {
  return {
    strategy: parseRoutingStrategy(readPath(routing, ['strategy'])),
    sessionAffinity: readBool(readPath(routing, ['session-affinity'])),
    sessionAffinityTTL: readText(readPath(routing, ['session-affinity-ttl'])),
    // Pointer-backed: absent means true.
    sessionAffinitySubagents: readBool(readPath(routing, ['session-affinity-subagents']), true),
    requestRetry: readText(readPath(routing, ['retry', 'request-retry'])),
    maxRetryCredentials: readText(readPath(routing, ['retry', 'max-retry-credentials'])),
    maxRetryInterval: readText(readPath(routing, ['retry', 'max-retry-interval'])),
    cooling: !readBool(readPath(routing, ['cooldown', 'disable-cooling'])),
    saveCooldownStatus: readBool(readPath(routing, ['cooldown', 'save-cooldown-status'])),
    transientErrorCooldownSeconds: readText(
      readPath(routing, ['cooldown', 'transient-error-cooldown-seconds'])
    ),
    claudeModelLevelCooling: upstream.claude,
    codexModelLevelCooling: upstream.codex,
  };
}

const settingEquals = (spec: SettingSpec, a: RoutingSettings, b: RoutingSettings): boolean => {
  const left = a[spec.key];
  const right = b[spec.key];
  if (typeof left === 'string' && typeof right === 'string') return left.trim() === right.trim();
  return left === right;
};

export function changedSettingKeys(
  baseline: RoutingSettings,
  settings: RoutingSettings
): RoutingSettingKey[] {
  return ROUTING_SETTING_SPECS.filter((spec) => !settingEquals(spec, baseline, settings)).map(
    (spec) => spec.key
  );
}

/* ============================================================
 * Parsing & validation
 * ============================================================ */

const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const DURATION_SEGMENT = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/y;

/** Go `time.ParseDuration` subset (unsigned). Returns milliseconds or null when invalid. */
export function parseGoDurationMs(text: string): number | null {
  const source = text.trim();
  if (!source) return null;
  if (source === '0') return 0;
  let total = 0;
  let index = 0;
  while (index < source.length) {
    DURATION_SEGMENT.lastIndex = index;
    const match = DURATION_SEGMENT.exec(source);
    if (!match) return null;
    total += Number.parseFloat(match[1]) * DURATION_UNIT_MS[match[2]];
    index = DURATION_SEGMENT.lastIndex;
  }
  return Number.isFinite(total) ? total : null;
}

/** Effective TTL the backend would apply (empty/invalid → 1h, clamped to ≥1s). */
export function effectiveTTLMs(text: string): number {
  const parsed = parseGoDurationMs(text);
  if (parsed === null || parsed <= 0) return DEFAULT_SESSION_AFFINITY_TTL_MS;
  return Math.max(parsed, MIN_SESSION_AFFINITY_TTL_MS);
}

export type RoutingFieldError = 'integer' | 'non_negative' | 'max' | 'duration' | 'duration_min';

const INTEGER_PATTERN = /^[+-]?\d+$/;

const parseInteger = (text: string): number | null => {
  const trimmed = text.trim();
  if (!INTEGER_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export function validateTTL(text: string): RoutingFieldError | null {
  if (!text.trim()) return null;
  const parsed = parseGoDurationMs(text);
  if (parsed === null) return 'duration';
  return parsed < MIN_SESSION_AFFINITY_TTL_MS ? 'duration_min' : null;
}

/** Empty = unset. `nonNegative` mirrors request-retry; others accept any integer. */
export function validateIntegerText(text: string, nonNegative = false): RoutingFieldError | null {
  if (!text.trim()) return null;
  const parsed = parseInteger(text);
  if (parsed === null || Math.abs(parsed) > MAX_PRIORITY) return 'integer';
  return nonNegative && parsed < 0 ? 'non_negative' : null;
}

/** Priority is required on a row: empty is an error, not "default". */
export function validatePriorityText(text: string): RoutingFieldError | null {
  const parsed = parseInteger(text);
  if (parsed === null) return 'integer';
  return Math.abs(parsed) > MAX_PRIORITY ? 'max' : null;
}

/** Empty = clear back to default weight (1). */
export function validateWeightText(text: string): RoutingFieldError | null {
  const error = validateCredentialWeightText(text);
  if (error) return error;
  const parsed = parseInteger(text);
  return parsed !== null && parsed < 0 ? 'non_negative' : null;
}

export function validateSetting(
  key: RoutingSettingKey,
  settings: RoutingSettings
): RoutingFieldError | null {
  switch (key) {
    case 'sessionAffinityTTL':
      return validateTTL(settings.sessionAffinityTTL);
    case 'requestRetry':
      return validateIntegerText(settings.requestRetry, true);
    case 'maxRetryCredentials':
    case 'maxRetryInterval':
    case 'transientErrorCooldownSeconds':
      return validateIntegerText(settings[key]);
    default:
      return null;
  }
}

/* ============================================================
 * Credentials, pools, tiers
 * ============================================================ */

export interface RoutingCredential {
  /** Patch identity (`name` for /credentials/fields). */
  key: string;
  name: string;
  provider: string;
  /** Email, else filename without `.json`. */
  label: string;
  authIndex?: string;
  disabled: boolean;
  /** Runtime-only credentials have no file to patch. */
  editable: boolean;
  priority: number;
  weight?: number;
  planType: string | null;
  cooldown?: AuthFileCooldownSnapshot;
}

const CLAUDE_PLAN_ALIASES: Record<string, string> = {
  max: 'plan_max',
  max5: 'plan_max5',
  max_5x: 'plan_max5',
  max20: 'plan_max20',
  max_20x: 'plan_max20',
  team: 'plan_team',
  enterprise: 'plan_team',
  pro: 'plan_pro',
  free: 'plan_free',
};

/** Accepts both the quota page's `plan_*` ids and bare credential claims. */
export function normalizeClaudePlanType(value: unknown): string | null {
  const normalized = normalizePlanType(value);
  if (!normalized) return null;
  const bare = normalized.replace(/^plan_/, '').replace(/^claude_/, '');
  return CLAUDE_PLAN_ALIASES[bare] ?? (normalized.startsWith('plan_') ? normalized : null);
}

const fileRecord = (file: AuthFileItem, key: string): Record<string, unknown> | null =>
  asRecord(file[key]);

/**
 * Plan from the credential itself, overridden by a known cached value (e.g. the
 * quota page's last successful fetch or a live passive header).
 */
export function resolveCredentialPlan(
  provider: string,
  file: AuthFileItem,
  cached?: string | null
): string | null {
  if (provider === 'codex') return normalizePlanType(cached) ?? resolveCodexPlanType(file);
  if (provider === 'claude') {
    const candidates = [
      cached,
      file.plan_type,
      file.planType,
      fileRecord(file, 'metadata')?.plan_type,
      fileRecord(file, 'attributes')?.plan_type,
    ];
    for (const candidate of candidates) {
      const plan = normalizeClaudePlanType(candidate);
      if (plan) return plan;
    }
  }
  return null;
}

const readAuthIndex = (file: AuthFileItem): string | undefined => {
  const raw = file.authIndex ?? file['auth_index'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
};

const readRuntimeOnly = (file: AuthFileItem): boolean => {
  const raw = file['runtime_only'] ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
};

export const providerOf = (file: AuthFileItem): string =>
  normalizeOAuthProviderKey(String(file.type ?? file.provider ?? '')) || '';

export function toRoutingCredentials(
  files: readonly AuthFileItem[],
  cachedPlan: (provider: string, file: AuthFileItem) => string | null = () => null
): RoutingCredential[] {
  const seen = new Set<string>();
  const result: RoutingCredential[] = [];
  for (const file of files) {
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    const provider = providerOf(file);
    if (!name || !provider || provider === 'empty' || provider === 'unknown') continue;
    // Several runtime identities may share one file; the file is the patch unit.
    if (seen.has(name)) continue;
    seen.add(name);
    const email = typeof file.email === 'string' ? file.email.trim() : '';
    result.push({
      key: name,
      name,
      provider,
      label: email || name.replace(/\.json$/i, ''),
      authIndex: readAuthIndex(file),
      disabled: file.disabled === true,
      editable: !readRuntimeOnly(file),
      priority: typeof file.priority === 'number' ? file.priority : 0,
      weight: typeof file.weight === 'number' ? file.weight : undefined,
      planType: resolveCredentialPlan(provider, file, cachedPlan(provider, file)),
      cooldown: file.cooldownSnapshot,
    });
  }
  return result;
}

const PROVIDER_ORDER = ['claude', 'codex'];

export interface ProviderPool {
  provider: string;
  credentials: RoutingCredential[];
}

export function groupByProvider(credentials: readonly RoutingCredential[]): ProviderPool[] {
  const byProvider = new Map<string, RoutingCredential[]>();
  for (const credential of credentials) {
    const list = byProvider.get(credential.provider) ?? [];
    list.push(credential);
    byProvider.set(credential.provider, list);
  }
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  return [...byProvider.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([provider, list]) => ({ provider, credentials: list }));
}

/* ---------- drafts ---------- */

export interface CredentialDraft {
  priority?: string;
  weight?: string;
  /** Newline-separated rules (AuthFileExcludedModelsField's value shape). */
  excludedText?: string;
}

export type CredentialDrafts = Readonly<Record<string, CredentialDraft>>;

export interface ExcludedBaseline {
  models: string[];
  field: 'excluded_models' | 'excluded-models';
}

export type ExcludedBaselines = Readonly<Record<string, ExcludedBaseline>>;

export function normalizeExcludedModels(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const model = item.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

/** Excluded models from a downloaded credential JSON (snake or kebab key). */
export function readExcludedBaseline(json: unknown): ExcludedBaseline {
  const record = asRecord(json) ?? {};
  const kebab = record.excluded_models === undefined && record['excluded-models'] !== undefined;
  return {
    models: normalizeExcludedModels(kebab ? record['excluded-models'] : record.excluded_models),
    field: kebab ? 'excluded-models' : 'excluded_models',
  };
}

export const savedWeightText = (credential: RoutingCredential): string =>
  credential.weight === undefined ? '' : String(credential.weight);

/** Apply an edit and drop fields that equal the saved value, keeping the map minimal. */
export function updateCredentialDraft(
  drafts: CredentialDrafts,
  credential: RoutingCredential,
  edit: CredentialDraft,
  excluded?: ExcludedBaseline
): Record<string, CredentialDraft> {
  const next: CredentialDraft = { ...drafts[credential.key], ...edit };
  if (next.priority !== undefined && parseInteger(next.priority) === credential.priority) {
    delete next.priority;
  }
  if (next.weight !== undefined && next.weight.trim() === savedWeightText(credential)) {
    delete next.weight;
  }
  if (
    next.excludedText !== undefined &&
    (!excluded || sameList(normalizeExcludedModels(next.excludedText), excluded.models))
  ) {
    delete next.excludedText;
  }
  const result: Record<string, CredentialDraft> = { ...drafts };
  if (Object.keys(next).length) result[credential.key] = next;
  else delete result[credential.key];
  return result;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

export function effectivePriority(credential: RoutingCredential, draft?: CredentialDraft): number {
  if (draft?.priority === undefined || validatePriorityText(draft.priority)) {
    return credential.priority;
  }
  return parseInteger(draft.priority) ?? credential.priority;
}

export type TierRole = 'primary' | 'fallback' | 'off';

export interface PriorityTier {
  priority: number;
  role: TierRole;
  credentials: RoutingCredential[];
}

/** Highest priority first. Only the highest tier with an enabled credential serves. */
export function groupIntoTiers(
  credentials: readonly RoutingCredential[],
  drafts: CredentialDrafts = {}
): PriorityTier[] {
  const byPriority = new Map<number, RoutingCredential[]>();
  for (const credential of credentials) {
    const priority = effectivePriority(credential, drafts[credential.key]);
    const list = byPriority.get(priority) ?? [];
    list.push(credential);
    byPriority.set(priority, list);
  }
  let primaryFound = false;
  return [...byPriority.entries()]
    .sort(([a], [b]) => b - a)
    .map(([priority, list]) => {
      const sorted = [...list].sort(
        (a, b) =>
          Number(a.disabled) - Number(b.disabled) ||
          a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
      );
      const hasEnabled = sorted.some((credential) => !credential.disabled);
      let role: TierRole;
      if (primaryFound) role = 'fallback';
      else if (hasEnabled) {
        role = 'primary';
        primaryFound = true;
      } else role = 'off';
      return { priority, role, credentials: sorted };
    });
}

/* ---------- presets ---------- */

export const PRESET_PRIORITY_STEP = 10;

/** Plan groups, best first. Plans not listed keep their current priority. */
const PLAN_PRESETS: Record<string, readonly (readonly string[])[]> = {
  codex: [
    ['pro', 'prolite', 'pro-lite', 'pro_lite', 'self_serve_business_prolite', 'plus'],
    ['team', 'business', 'enterprise', 'edu'],
    ['go', 'free'],
  ],
  claude: [['plan_max', 'plan_max5', 'plan_max20'], ['plan_team'], ['plan_pro'], ['plan_free']],
};

export const supportsPlanPreset = (provider: string): boolean =>
  Object.prototype.hasOwnProperty.call(PLAN_PRESETS, provider);

export function planPresetPriority(provider: string, planType: string | null): number | null {
  const groups = PLAN_PRESETS[provider];
  if (!groups || !planType) return null;
  const index = groups.findIndex((group) => group.includes(planType));
  return index === -1 ? null : (groups.length - 1 - index) * PRESET_PRIORITY_STEP;
}

export interface PresetResult {
  drafts: Record<string, CredentialDraft>;
  applied: number;
  skipped: number;
}

/** "By plan": fill priority drafts from plan rank. Unknown plans are left untouched. */
export function applyPlanPreset(
  credentials: readonly RoutingCredential[],
  drafts: CredentialDrafts
): PresetResult {
  let next: Record<string, CredentialDraft> = { ...drafts };
  let applied = 0;
  let skipped = 0;
  for (const credential of credentials) {
    if (!credential.editable) continue;
    const priority = planPresetPriority(credential.provider, credential.planType);
    if (priority === null) {
      skipped += 1;
      continue;
    }
    applied += 1;
    next = updateCredentialDraft(next, credential, { priority: String(priority) });
  }
  return { drafts: next, applied, skipped };
}

/** "Flat": everyone in one tier (priority 0). */
export function applyFlatPreset(
  credentials: readonly RoutingCredential[],
  drafts: CredentialDrafts
): Record<string, CredentialDraft> {
  let next: Record<string, CredentialDraft> = { ...drafts };
  for (const credential of credentials) {
    if (credential.editable) next = updateCredentialDraft(next, credential, { priority: '0' });
  }
  return next;
}

/* ---------- runtime state ---------- */

export type CredentialState =
  | { kind: 'off' }
  | { kind: 'ready' }
  | { kind: 'unknown' }
  | { kind: 'cooling'; scope: 'credential' | 'models'; modelCount: number; seconds: number };

export function credentialState(credential: RoutingCredential, nowMs: number): CredentialState {
  if (credential.disabled) return { kind: 'off' };
  const snapshot = credential.cooldown;
  if (!snapshot) return { kind: 'ready' };
  if (snapshot.records === null) return { kind: 'unknown' };
  const summary = summarizeCooldowns(snapshot, nowMs);
  if (!summary.credentialWide && summary.modelCount === 0) return { kind: 'ready' };
  return {
    kind: 'cooling',
    scope: summary.credentialWide ? 'credential' : 'models',
    modelCount: summary.modelCount,
    seconds: summary.earliestSeconds,
  };
}

/* ============================================================
 * Validation & save plan
 * ============================================================ */

export interface CredentialFieldErrors {
  priority?: RoutingFieldError;
  weight?: RoutingFieldError;
}

export interface RoutingValidation {
  settings: Partial<Record<RoutingSettingKey, RoutingFieldError>>;
  credentials: Record<string, CredentialFieldErrors>;
  valid: boolean;
}

export interface RoutingDraftState {
  baseline: RoutingSettings;
  settings: RoutingSettings;
  credentials: readonly RoutingCredential[];
  drafts: CredentialDrafts;
  excluded: ExcludedBaselines;
}

const weightsApply = (settings: RoutingSettings) => settings.strategy === 'weighted-round-robin';

/** Only changed fields are validated: untouched odd server values never block a save. */
export function validateRoutingDraft(state: RoutingDraftState): RoutingValidation {
  const settings: RoutingValidation['settings'] = {};
  for (const key of changedSettingKeys(state.baseline, state.settings)) {
    const error = validateSetting(key, state.settings);
    if (error) settings[key] = error;
  }
  const credentials: Record<string, CredentialFieldErrors> = {};
  for (const credential of state.credentials) {
    const draft = state.drafts[credential.key];
    if (!draft) continue;
    const errors: CredentialFieldErrors = {};
    if (draft.priority !== undefined) {
      const error = validatePriorityText(draft.priority);
      if (error) errors.priority = error;
    }
    if (draft.weight !== undefined && weightsApply(state.settings)) {
      const error = validateWeightText(draft.weight);
      if (error) errors.weight = error;
    }
    if (errors.priority || errors.weight) credentials[credential.key] = errors;
  }
  return {
    settings,
    credentials,
    valid: !Object.keys(settings).length && !Object.keys(credentials).length,
  };
}

export interface CredentialPatch {
  name: string;
  label: string;
  fields: AuthFileFieldsPatch;
}

export interface RoutingSavePlan {
  /** Merge patch relative to `/config/routing`. */
  routingPatch: Record<string, unknown>;
  /** Leaf paths relative to `routing` to DELETE (cleared back to default). */
  routingDeletions: string[][];
  upstreamPatch: UpstreamCoolingPatch;
  credentialPatches: CredentialPatch[];
  /** Every pending edit, including currently invalid ones. */
  changeCount: number;
}

const setIn = (target: Record<string, unknown>, path: readonly string[], value: unknown) => {
  let node = target;
  path.slice(0, -1).forEach((key) => {
    const child = asRecord(node[key]);
    if (child) node = child;
    else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  });
  node[path[path.length - 1]] = value;
};

export function buildRoutingSavePlan(state: RoutingDraftState): RoutingSavePlan {
  const routingPatch: Record<string, unknown> = {};
  const routingDeletions: string[][] = [];
  const upstreamPatch: UpstreamCoolingPatch = {};
  let changeCount = 0;

  for (const key of changedSettingKeys(state.baseline, state.settings)) {
    changeCount += 1;
    if (validateSetting(key, state.settings)) continue;
    const spec = ROUTING_SETTING_SPECS.find((entry) => entry.key === key)!;
    const value = state.settings[key];
    if (spec.upstream) {
      upstreamPatch[spec.upstream] = Boolean(value);
      continue;
    }
    switch (spec.kind) {
      case 'boolean':
        setIn(routingPatch, spec.path, Boolean(value));
        break;
      case 'inverted':
        setIn(routingPatch, spec.path, !value);
        break;
      case 'integer': {
        const text = String(value).trim();
        if (text) setIn(routingPatch, spec.path, Number(text));
        else routingDeletions.push([...spec.path]);
        break;
      }
      default: {
        const text = String(value).trim();
        if (text) setIn(routingPatch, spec.path, text);
        else routingDeletions.push([...spec.path]);
      }
    }
  }

  const credentialPatches: CredentialPatch[] = [];
  for (const credential of state.credentials) {
    const draft = state.drafts[credential.key];
    if (!draft || !credential.editable) continue;
    const fields: AuthFileFieldsPatch = {};
    if (draft.priority !== undefined) {
      const parsed = parseInteger(draft.priority);
      if (parsed !== credential.priority) {
        changeCount += 1;
        if (!validatePriorityText(draft.priority) && parsed !== null) fields.priority = parsed;
      }
    }
    if (draft.weight !== undefined && weightsApply(state.settings)) {
      const text = draft.weight.trim();
      if (text !== savedWeightText(credential)) {
        changeCount += 1;
        if (!validateWeightText(text)) fields.weight = text ? Number(text) : null;
      }
    }
    const excluded = state.excluded[credential.key];
    if (draft.excludedText !== undefined && excluded) {
      const models = normalizeExcludedModels(draft.excludedText);
      if (!sameList(models, excluded.models)) {
        changeCount += 1;
        fields[excluded.field] = models;
      }
    }
    if (Object.keys(fields).length) {
      credentialPatches.push({ name: credential.name, label: credential.label, fields });
    }
  }

  return { routingPatch, routingDeletions, upstreamPatch, credentialPatches, changeCount };
}

export const hasConfigChanges = (plan: RoutingSavePlan): boolean =>
  Object.keys(plan.routingPatch).length > 0 ||
  plan.routingDeletions.length > 0 ||
  Object.keys(plan.upstreamPatch).length > 0;

/**
 * Whether saving may drop live sticky bindings: the backend rebuilds its
 * selector (and session cache) only when the effective routing state changes
 * while session affinity is currently on.
 */
export function stickyResetRisk(baseline: RoutingSettings, settings: RoutingSettings): boolean {
  if (!baseline.sessionAffinity) return false;
  if (baseline.strategy !== settings.strategy) return true;
  if (!settings.sessionAffinity) return true;
  if (effectiveTTLMs(baseline.sessionAffinityTTL) !== effectiveTTLMs(settings.sessionAffinityTTL)) {
    return true;
  }
  return baseline.sessionAffinitySubagents !== settings.sessionAffinitySubagents;
}

/** Credential keys whose patch succeeded are cleared; failed ones keep their draft. */
export function pruneSavedDrafts(
  drafts: CredentialDrafts,
  savedNames: readonly string[]
): Record<string, CredentialDraft> {
  const next: Record<string, CredentialDraft> = { ...drafts };
  savedNames.forEach((name) => delete next[name]);
  return next;
}
