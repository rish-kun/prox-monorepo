/**
 * Codex 额度数据层：用量窗口 + 套餐 + 重置积分（含消费流程）。
 * React-free / SCSS-free —— 由 tests/codexQuota.test.ts 直接消费。
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CodexAccountCredits,
  CodexRateLimitInfo,
  CodexRateLimitResetCredit,
  CodexQuotaState,
  CodexUsageWindow,
  CodexQuotaWindow,
  CodexUsagePayload,
} from '@/types';
import {
  apiCallApi,
  authFilesApi,
  getApiCallErrorMessage,
  type QuotaSnapshot,
} from '@/services/api';
import { guardConfigConnection } from '@/services/api/configValue';
import { isRecord } from '@/utils/helpers';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_REQUEST_HEADERS,
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  normalizeCodexResetCreditsPayload,
  parseCodexUsagePayload,
  parseOffsetSecondsToMs,
  periodHoursFromSeconds,
  resolveResetMs,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
  resolveCodexSubscriptionActiveUntil,
  formatCodexResetLabel,
  createStatusError,
  isCodexFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  isOkResponse,
  refreshSnapshotFor,
  requireSnapshotUsage,
  snapshotResponseError,
} from '../../snapshotBundle';
import type { QuotaProviderData } from '../types';

type CodexResetCreditsData = {
  availableCount: number | null;
  applicableAvailableCount: number | null;
  credits: CodexRateLimitResetCredit[];
  error: string;
};

export type CodexQuotaData = {
  planType: string | null;
  subscriptionActiveUntil: string | number | null;
  creditBalance: string | null;
  creditsUnlimited: boolean;
  rateLimitResetCreditsAvailableCount: number | null;
  rateLimitResetCreditsApplicableAvailableCount: number | null;
  rateLimitResetCredits: CodexRateLimitResetCredit[];
  rateLimitResetCreditsError: string;
  windows: CodexQuotaWindow[];
  /** The proxy's fetch time for the snapshot this was built from. */
  fetchedAtMs?: number;
};

export const buildCodexQuotaWindows = (
  payload: CodexUsagePayload,
  t: TFunction,
  /** When the payload was fetched: `reset_after_seconds` counts from here. */
  fetchedAtMs: number = Date.now()
): CodexQuotaWindow[] => {
  const FIVE_HOUR_SECONDS = 18000;
  const WEEK_SECONDS = 604800;
  const MIN_MONTH_SECONDS = 28 * 24 * 60 * 60;
  const MAX_MONTH_SECONDS = 31 * 24 * 60 * 60;
  const WINDOW_META = {
    codeFiveHour: { id: 'five-hour', labelKey: 'codex_quota.primary_window' },
    codeWeekly: { id: 'weekly', labelKey: 'codex_quota.secondary_window' },
    codeMonthly: { id: 'monthly', labelKey: 'codex_quota.team_secondary_window' },
    codeReviewFiveHour: {
      id: 'code-review-five-hour',
      labelKey: 'codex_quota.code_review_primary_window',
    },
    codeReviewWeekly: {
      id: 'code-review-weekly',
      labelKey: 'codex_quota.code_review_secondary_window',
    },
    codeReviewMonthly: {
      id: 'code-review-monthly',
      labelKey: 'codex_quota.code_review_team_secondary_window',
    },
  } as const;

  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const codeReviewLimit =
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined;
  const additionalRateLimits = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];
  const windows: CodexQuotaWindow[] = [];

  const addWindow = (
    id: string,
    label: string,
    labelKey: string | undefined,
    labelParams: Record<string, string | number> | undefined,
    window?: CodexUsageWindow | null,
    limitReached?: boolean,
    allowed?: boolean
  ) => {
    if (!window) return;
    const resetLabel = formatCodexResetLabel(window);
    const usedPercentRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const isLimitReached = Boolean(limitReached) || allowed === false;
    const usedPercent = usedPercentRaw ?? (isLimitReached && resetLabel !== '-' ? 100 : null);
    // Keep the raw instant beside the label — see utils/quota/resetInstants.
    const resetAtMs =
      resolveResetMs([window.reset_at, window.resetAt]) ??
      parseOffsetSecondsToMs(window.reset_after_seconds ?? window.resetAfterSeconds, fetchedAtMs);
    const periodHours = periodHoursFromSeconds(
      window.limit_window_seconds ?? window.limitWindowSeconds
    );
    windows.push({
      id,
      label,
      labelKey,
      labelParams,
      usedPercent,
      resetAtMs,
      periodHours,
      resetLabel,
    });
  };

  const getWindowSeconds = (window?: CodexUsageWindow | null): number | null => {
    if (!window) return null;
    return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
  };

  const isMonthlyWindow = (window?: CodexUsageWindow | null): boolean => {
    const seconds = getWindowSeconds(window);
    return seconds !== null && seconds >= MIN_MONTH_SECONDS && seconds <= MAX_MONTH_SECONDS;
  };

  const selectSecondaryWindowMeta = <
    TWeekly extends { id: string; labelKey: string },
    TMonthly extends { id: string; labelKey: string },
  >(
    window: CodexUsageWindow | null | undefined,
    weeklyMeta: TWeekly,
    monthlyMeta: TMonthly
  ): TWeekly | TMonthly => (isMonthlyWindow(window) ? monthlyMeta : weeklyMeta);

  const rawLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const rawAllowed = rateLimit?.allowed;

  const pickClassifiedWindows = (
    limitInfo?: CodexRateLimitInfo | null,
    options?: { allowOrderFallback?: boolean }
  ): { fiveHourWindow: CodexUsageWindow | null; weeklyWindow: CodexUsageWindow | null } => {
    const allowOrderFallback = options?.allowOrderFallback ?? true;
    const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
    const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
    const rawWindows = [primaryWindow, secondaryWindow];

    let fiveHourWindow: CodexUsageWindow | null = null;
    let weeklyWindow: CodexUsageWindow | null = null;

    for (const window of rawWindows) {
      if (!window) continue;
      const seconds = getWindowSeconds(window);
      if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
        fiveHourWindow = window;
      } else if ((seconds === WEEK_SECONDS || isMonthlyWindow(window)) && !weeklyWindow) {
        weeklyWindow = window;
      }
    }

    // For legacy payloads without window duration, fallback to primary/secondary ordering.
    if (allowOrderFallback) {
      if (!fiveHourWindow) {
        fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
      }
      if (!weeklyWindow) {
        weeklyWindow =
          secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
      }
    }

    return { fiveHourWindow, weeklyWindow };
  };

  const rateWindows = pickClassifiedWindows(rateLimit);
  addWindow(
    WINDOW_META.codeFiveHour.id,
    t(WINDOW_META.codeFiveHour.labelKey),
    WINDOW_META.codeFiveHour.labelKey,
    undefined,
    rateWindows.fiveHourWindow,
    rawLimitReached,
    rawAllowed
  );
  const codeSecondaryWindowMeta = selectSecondaryWindowMeta(
    rateWindows.weeklyWindow,
    WINDOW_META.codeWeekly,
    WINDOW_META.codeMonthly
  );
  addWindow(
    codeSecondaryWindowMeta.id,
    t(codeSecondaryWindowMeta.labelKey),
    codeSecondaryWindowMeta.labelKey,
    undefined,
    rateWindows.weeklyWindow,
    rawLimitReached,
    rawAllowed
  );

  const codeReviewWindows = pickClassifiedWindows(codeReviewLimit);
  const codeReviewLimitReached = codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached;
  const codeReviewAllowed = codeReviewLimit?.allowed;
  addWindow(
    WINDOW_META.codeReviewFiveHour.id,
    t(WINDOW_META.codeReviewFiveHour.labelKey),
    WINDOW_META.codeReviewFiveHour.labelKey,
    undefined,
    codeReviewWindows.fiveHourWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );
  const codeReviewSecondaryWindowMeta = selectSecondaryWindowMeta(
    codeReviewWindows.weeklyWindow,
    WINDOW_META.codeReviewWeekly,
    WINDOW_META.codeReviewMonthly
  );
  addWindow(
    codeReviewSecondaryWindowMeta.id,
    t(codeReviewSecondaryWindowMeta.labelKey),
    codeReviewSecondaryWindowMeta.labelKey,
    undefined,
    codeReviewWindows.weeklyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );

  const normalizeWindowId = (raw: string) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  if (Array.isArray(additionalRateLimits)) {
    additionalRateLimits.forEach((limitItem, index) => {
      const rateInfo = limitItem?.rate_limit ?? limitItem?.rateLimit ?? null;
      if (!rateInfo) return;

      const limitName =
        normalizeStringValue(limitItem?.limit_name ?? limitItem?.limitName) ??
        normalizeStringValue(limitItem?.metered_feature ?? limitItem?.meteredFeature) ??
        `additional-${index + 1}`;

      const idPrefix = normalizeWindowId(limitName) || `additional-${index + 1}`;
      const additionalWindows = pickClassifiedWindows(rateInfo);
      const additionalLimitReached = rateInfo.limit_reached ?? rateInfo.limitReached;
      const additionalAllowed = rateInfo.allowed;

      addWindow(
        `${idPrefix}-five-hour-${index}`,
        t('codex_quota.additional_primary_window', { name: limitName }),
        'codex_quota.additional_primary_window',
        { name: limitName },
        additionalWindows.fiveHourWindow,
        additionalLimitReached,
        additionalAllowed
      );
      const additionalSecondaryMeta = selectSecondaryWindowMeta(
        additionalWindows.weeklyWindow,
        { id: 'weekly', labelKey: 'codex_quota.additional_secondary_window' },
        { id: 'monthly', labelKey: 'codex_quota.additional_team_secondary_window' }
      );
      addWindow(
        `${idPrefix}-${additionalSecondaryMeta.id}-${index}`,
        t(additionalSecondaryMeta.labelKey, { name: limitName }),
        additionalSecondaryMeta.labelKey,
        { name: limitName },
        additionalWindows.weeklyWindow,
        additionalLimitReached,
        additionalAllowed
      );
    });
  }

  return windows;
};

export const normalizeCodexAccountCredits = (
  credits: CodexAccountCredits | null | undefined
): { balance: string | null; unlimited: boolean } => {
  const value = credits?.balance;
  const balance =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  return {
    balance:
      balance && /^\d+(?:\.\d+)?$/.test(balance) && Number.isFinite(Number(balance))
        ? balance
        : null,
    unlimited: credits?.unlimited === true,
  };
};

const buildCodexRequestHeader = (file: AuthFileItem): Record<string, string> => {
  const accountId = resolveCodexChatgptAccountId(file);
  const requestHeader: Record<string, string> = {
    ...CODEX_REQUEST_HEADERS,
  };
  if (accountId) {
    requestHeader['Chatgpt-Account-Id'] = accountId;
  }
  return requestHeader;
};

const parseCodexSubscriptionActiveUntil = (payload: unknown): string | number | null => {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return parseCodexSubscriptionActiveUntil(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const subscription = payload as Record<string, unknown>;
  const value = subscription.active_until ?? subscription.activeUntil;
  const numberValue = normalizeNumberValue(value);
  if (numberValue !== null && numberValue !== 0) return numberValue;
  const stringValue = normalizeStringValue(value);
  return stringValue && stringValue !== '0' ? stringValue : null;
};

const NO_RESET_CREDITS: CodexResetCreditsData = {
  availableCount: null,
  applicableAvailableCount: null,
  credits: [],
  error: '',
};

/** The proxy's `reset_credits` response; never fails the snapshot. */
const readCodexResetCredits = (snapshot: QuotaSnapshot, t: TFunction): CodexResetCreditsData => {
  const response = snapshot.responses.reset_credits;
  if (!response) return NO_RESET_CREDITS;
  if (!isOkResponse(response)) {
    return { ...NO_RESET_CREDITS, error: snapshotResponseError(response) };
  }
  const summary = normalizeCodexResetCreditsPayload(response.body ?? response.bodyText);
  if (summary.invalidPayload) {
    return { ...NO_RESET_CREDITS, error: t('codex_quota.reset_credits_invalid_payload') };
  }
  return {
    availableCount: summary.availableCount,
    applicableAvailableCount: summary.applicableAvailableCount,
    credits: summary.credits,
    error: '',
  };
};

/**
 * Build quota data from the proxy's snapshot bundle (`usage`, `subscription`,
 * `reset_credits`), the same parsing the direct `api-call` path used to do.
 */
export const buildCodexQuotaFromSnapshot = (
  snapshot: QuotaSnapshot,
  file: AuthFileItem,
  t: TFunction
): CodexQuotaData => {
  const result = requireSnapshotUsage(snapshot, t('codex_quota.empty_windows'));
  const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('codex_quota.empty_windows'));
  }

  const subscription = snapshot.responses.subscription;
  const liveSubscriptionActiveUntil = isOkResponse(subscription)
    ? parseCodexSubscriptionActiveUntil(subscription.body ?? subscription.bodyText)
    : null;
  const planTypeFromUsage = normalizePlanType(payload.plan_type ?? payload.planType);
  const accountCredits = normalizeCodexAccountCredits(payload.credits);
  const resetCredits = payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits ?? null;
  const usageResetCreditsData = normalizeCodexResetCreditsPayload(resetCredits);
  const resetCreditsData = readCodexResetCredits(snapshot, t);
  const resetCreditsCountFromDetails =
    resetCreditsData.credits.length > 0 ? resetCreditsData.credits.length : null;
  const rateLimitResetCreditsAvailableCount =
    resetCreditsData.availableCount ??
    resetCreditsCountFromDetails ??
    usageResetCreditsData.availableCount;
  const rateLimitResetCreditsApplicableAvailableCount =
    usageResetCreditsData.applicableAvailableCount ??
    resetCreditsData.applicableAvailableCount ??
    rateLimitResetCreditsAvailableCount;
  const planType = planTypeFromUsage ?? resolveCodexPlanType(file);
  const subscriptionActiveUntil =
    liveSubscriptionActiveUntil ?? resolveCodexSubscriptionActiveUntil(file);
  const fetchedAtMs = snapshot.fetchedAtMs ?? undefined;
  const windows = buildCodexQuotaWindows(payload, t, fetchedAtMs);
  return {
    planType,
    subscriptionActiveUntil,
    creditBalance: accountCredits.balance,
    creditsUnlimited: accountCredits.unlimited,
    rateLimitResetCreditsAvailableCount,
    rateLimitResetCreditsApplicableAvailableCount,
    rateLimitResetCredits: resetCreditsData.credits,
    rateLimitResetCreditsError: resetCreditsData.error,
    windows,
    fetchedAtMs,
  };
};

const requireCodexAuthIndex = (file: AuthFileItem, t: TFunction): string => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('codex_quota.missing_auth_index'));
  }
  return authIndex;
};

/** Refresh through the proxy — the panel never calls the Codex usage endpoints itself. */
const fetchCodexQuota = async (file: AuthFileItem, t: TFunction): Promise<CodexQuotaData> =>
  buildCodexQuotaFromSnapshot(await refreshSnapshotFor(requireCodexAuthIndex(file, t)), file, t);

const createCodexRedeemRequestId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const segment = char === 'x' ? value : (value & 0x3) | 0x8;
    return segment.toString(16);
  });
};

const consumeCodexRateLimitResetCredit = async (
  file: AuthFileItem,
  t: TFunction
): Promise<string> => {
  const authIndex = requireCodexAuthIndex(file, t);
  const requestHeader = buildCodexRequestHeader(file);

  // Consuming a credit is an action, not a quota read: it stays a direct api-call.
  const result = await apiCallApi.request({
    authIndex,
    method: 'POST',
    url: CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
    header: requestHeader,
    data: JSON.stringify({
      redeem_request_id: createCodexRedeemRequestId(),
    }),
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }
  const code = isRecord(result.body) ? result.body.code : undefined;
  if (code !== 'reset' && code !== 'already_redeemed') {
    throw new Error(t('codex_quota.reset_not_confirmed'));
  }
  return authIndex;
};

const resetCodexQuota = async (file: AuthFileItem, t: TFunction): Promise<CodexQuotaData> => {
  const assertConnection = guardConfigConnection();
  const authIndex = await consumeCodexRateLimitResetCredit(file, t);
  try {
    // Never clear a different connection's cooldown after awaiting redemption.
    assertConnection();
    const result = await authFilesApi.resetCooldown(authIndex);
    assertConnection();
    if (result.status !== 'ok' || result.auth_index !== authIndex) {
      throw new Error('Invalid cooldown reset response');
    }
  } catch {
    // Redemption already succeeded: direct the operator to the existing clear action.
    throw new Error(t('codex_quota.reset_cooldown_failed'));
  }
  // The proxy's 60 s minimum interval would return the pre-reset snapshot.
  return buildCodexQuotaFromSnapshot(await refreshSnapshotFor(authIndex, { force: true }), file, t);
};

export const CODEX_CONFIG: QuotaProviderData<CodexQuotaState, CodexQuotaData> = {
  type: 'codex',
  i18nPrefix: 'codex_quota',
  filterFn: (file) => isCodexFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchCodexQuota,
  fromSnapshot: buildCodexQuotaFromSnapshot,
  resetQuota: resetCodexQuota,
  canResetQuota: (quota) => (quota.rateLimitResetCreditsAvailableCount ?? 0) > 0,
  storeSelector: (state) => state.codexQuota,
  storeSetter: 'setCodexQuota',
  buildLoadingState: () => ({
    status: 'loading',
    windows: [],
    rateLimitResetCredits: [],
    rateLimitResetCreditsError: '',
  }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    planType: data.planType,
    subscriptionActiveUntil: data.subscriptionActiveUntil,
    creditBalance: data.creditBalance,
    creditsUnlimited: data.creditsUnlimited,
    rateLimitResetCreditsAvailableCount: data.rateLimitResetCreditsAvailableCount,
    rateLimitResetCreditsApplicableAvailableCount:
      data.rateLimitResetCreditsApplicableAvailableCount,
    rateLimitResetCredits: data.rateLimitResetCredits,
    rateLimitResetCreditsError: data.rateLimitResetCreditsError,
    fetchedAtMs: data.fetchedAtMs,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    rateLimitResetCredits: [],
    rateLimitResetCreditsError: '',
    error: message,
    errorStatus: status,
  }),
};
