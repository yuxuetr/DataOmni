/**
 * 工作区快照的持久化。
 *
 * 只保存能重建工作现场的最小集合：标签、最后活动的标签、以及每个 SQL 标签的
 * 草稿文本。**不保存查询结果**——结果可以重新执行得到，写进 localStorage 只会
 * 撑爆配额，并且让用户看到一份可能早已过期的数据。
 */

import type { WorkspaceTab } from '../contracts/workspace';
import { useQueryStore } from '../stores/queryStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

const STORAGE_KEY = 'dataomni_workspace';
const SNAPSHOT_VERSION = 1;

export interface WorkspaceSnapshot {
  version: number;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** 标签 id -> SQL 草稿文本 */
  drafts: Record<string, string>;
  savedAt: string;
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const tab = value as Partial<WorkspaceTab>;
  if (typeof tab.id !== 'string' || tab.id.length === 0) {
    return false;
  }
  if (tab.kind !== 'sql' && tab.kind !== 'table-data' && tab.kind !== 'table-structure') {
    return false;
  }
  if (typeof tab.title !== 'string') {
    return false;
  }
  if (typeof tab.binding !== 'object' || tab.binding === null) {
    return false;
  }
  if (typeof tab.binding.profileId !== 'string') {
    return false;
  }

  // 表标签必须带得回它指向的对象，否则恢复出来是个打不开的空壳
  if (tab.kind !== 'sql') {
    const object = (tab as { object?: { table?: unknown } }).object;
    if (typeof object !== 'object' || object === null || typeof object.table !== 'string') {
      return false;
    }
  }

  return true;
}

function normalizeTab(tab: WorkspaceTab): WorkspaceTab {
  // 会话是运行期的东西，重启后一律作废，由重新连接重建
  return {
    ...tab,
    binding: { profileId: tab.binding.profileId, sessionId: null }
  };
}

/**
 * 读取上次的工作区快照。
 *
 * 任何一步出问题都返回 null 而不是抛：localStorage 可能被禁用、内容可能被
 * 手工改过或来自更早的版本，任何一种都不该让应用起不来。
 */
export function loadWorkspaceSnapshot(): WorkspaceSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn('读取工作区快照失败，按空工作区启动:', error);
    return null;
  }

  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('工作区快照不是合法 JSON，已忽略:', error);
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const snapshot = parsed as Partial<WorkspaceSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.tabs)) {
    return null;
  }

  // 逐个校验：坏掉的标签单独丢弃，不连累整份快照
  const tabs = snapshot.tabs.filter(isWorkspaceTab).map(normalizeTab);
  const tabIds = new Set(tabs.map((tab) => tab.id));

  const drafts: Record<string, string> = {};
  if (typeof snapshot.drafts === 'object' && snapshot.drafts !== null) {
    for (const [tabId, draft] of Object.entries(snapshot.drafts)) {
      // 没有对应标签的草稿留着也没人能看到
      if (tabIds.has(tabId) && typeof draft === 'string') {
        drafts[tabId] = draft;
      }
    }
  }

  const activeTabId = typeof snapshot.activeTabId === 'string' && tabIds.has(snapshot.activeTabId)
    ? snapshot.activeTabId
    : tabs[0]?.id ?? null;

  return {
    version: SNAPSHOT_VERSION,
    tabs,
    activeTabId,
    drafts,
    savedAt: typeof snapshot.savedAt === 'string' ? snapshot.savedAt : new Date().toISOString()
  };
}

export function saveWorkspaceSnapshot(
  snapshot: Omit<WorkspaceSnapshot, 'version' | 'savedAt'>
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SNAPSHOT_VERSION,
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      drafts: snapshot.drafts,
      savedAt: new Date().toISOString()
    } satisfies WorkspaceSnapshot));
  } catch (error) {
    // 配额满或隐私模式下写入会抛，丢一次快照不该影响正在进行的工作
    console.warn('保存工作区快照失败:', error);
  }
}

export function clearWorkspaceSnapshot(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('清除工作区快照失败:', error);
  }
}

/**
 * 把上次的快照灌回 store。
 *
 * 在 React 渲染之前调用（见 main.tsx）：如果放到 effect 里，首帧的空工作区
 * 会先被保存 effect 写出去一次，把快照覆盖成空的。
 */
export function restoreWorkspaceFromSnapshot(): void {
  const snapshot = loadWorkspaceSnapshot();
  if (!snapshot || snapshot.tabs.length === 0) {
    return;
  }

  useWorkspaceStore.getState().restoreTabs(snapshot.tabs, snapshot.activeTabId);
  useQueryStore.getState().restoreDocuments(snapshot.drafts);
}
