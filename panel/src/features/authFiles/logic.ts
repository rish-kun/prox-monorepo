/**
 * 认证文件列表纯逻辑：按提供商分组、行健康度、组摘要。
 * React-free —— 由 tests/authFilesListLogic.test.ts 直接消费。
 */

import type { AuthFileItem } from '@/types';
import { resolveAuthProvider } from '@/utils/quota';
import {
  QUOTA_PROVIDER_TYPES,
  isProblemAuthFile,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  type AuthFileQuotaFilter,
  type QuotaProviderType,
} from './constants';
import { summarizeCooldowns } from './cooldowns';

/** 超过此行数的组默认只渲染前 N 行，由「显示全部」展开。 */
export const AUTH_FILE_GROUP_ROW_LIMIT = 50;

/** “全部”展示每张受支持凭证自己的额度；指定提供商时只展示匹配的额度。 */
export const resolveAuthFileQuotaType = (
  file: AuthFileItem,
  filter: AuthFileQuotaFilter
): QuotaProviderType | null => {
  if (!filter) return null;

  const provider = resolveAuthProvider(file);
  if (!QUOTA_PROVIDER_TYPES.has(provider as QuotaProviderType)) return null;
  if (filter !== 'all' && provider !== filter) return null;

  return provider as QuotaProviderType;
};

/** 分组键：type 优先、provider 兜底；都缺失时归入 unknown。 */
export const getAuthFileProviderKey = (file: AuthFileItem): string =>
  normalizeProviderKey(String(file.type ?? file.provider ?? '')) || 'unknown';

export type AuthFileGroup = {
  type: string;
  files: AuthFileItem[];
};

const UNKNOWN_PROVIDER_KEYS = new Set(['unknown', 'empty']);

/**
 * 每个提供商一组：组按 provider 键字母序（unknown/empty 垫底），
 * 组内按文件名排序（同名再按 authIndex）—— 后台刷新不会让行跳动。
 * 返回新数组，不改动入参。
 */
export const groupAuthFilesByProvider = (files: readonly AuthFileItem[]): AuthFileGroup[] => {
  const byType = new Map<string, AuthFileItem[]>();
  for (const file of files) {
    const type = getAuthFileProviderKey(file);
    const list = byType.get(type);
    if (list) list.push(file);
    else byType.set(type, [file]);
  }
  return Array.from(byType, ([type, list]) => ({
    type,
    files: [...list].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        String(a.authIndex ?? '').localeCompare(String(b.authIndex ?? ''))
    ),
  })).sort((a, b) => {
    const unknownA = UNKNOWN_PROVIDER_KEYS.has(a.type);
    const unknownB = UNKNOWN_PROVIDER_KEYS.has(b.type);
    if (unknownA !== unknownB) return unknownA ? 1 : -1;
    return a.type.localeCompare(b.type);
  });
};

export type AuthFileHealth =
  | { kind: 'ok' }
  | { kind: 'cooling'; seconds: number }
  | { kind: 'problem' }
  | { kind: 'disabled' };

/**
 * 行健康度（决定状态点/方块颜色与是否出声）：
 * 停用 > 问题（不可用/错误/非健康 status_message）> 冷却中 > 正常。
 */
export const resolveAuthFileHealth = (file: AuthFileItem, nowMs: number): AuthFileHealth => {
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (file.disabled === true || status === 'disabled') return { kind: 'disabled' };
  if (isProblemAuthFile(file)) return { kind: 'problem' };
  const snapshot = file.cooldownSnapshot;
  if (snapshot?.records?.length) {
    const { earliestSeconds } = summarizeCooldowns(snapshot, nowMs);
    if (earliestSeconds > 0) return { kind: 'cooling', seconds: earliestSeconds };
  }
  return { kind: 'ok' };
};

export type AuthFileGroupSummary = {
  total: number;
  /** 启用且无问题（含仅冷却中）的凭证数。 */
  active: number;
  /** 可勾选（非 runtime-only）的问题凭证 —— 「N 个问题」按钮选中的就是它们。 */
  problemFiles: AuthFileItem[];
  /** 组内全部问题凭证数（含不可勾选的虚拟凭证）。 */
  problemCount: number;
};

export const summarizeAuthFileGroup = (
  files: readonly AuthFileItem[],
  healthOf: (file: AuthFileItem) => AuthFileHealth
): AuthFileGroupSummary => {
  let active = 0;
  let problemCount = 0;
  const problemFiles: AuthFileItem[] = [];
  for (const file of files) {
    const kind = healthOf(file).kind;
    if (kind === 'ok' || kind === 'cooling') active += 1;
    if (kind === 'problem') {
      problemCount += 1;
      if (!isRuntimeOnlyAuthFile(file)) problemFiles.push(file);
    }
  }
  return { total: files.length, active, problemFiles, problemCount };
};

/** 规范化 provider 键后计数（排除模型 / 别名映射的键名可能大小写不一）。 */
export const countByProviderKey = (
  record: Record<string, readonly unknown[] | undefined>
): Map<string, number> => {
  const counts = new Map<string, number>();
  Object.entries(record).forEach(([provider, items]) => {
    const key = normalizeProviderKey(provider);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + (items?.length ?? 0));
  });
  return counts;
};
