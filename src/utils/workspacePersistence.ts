/**
 * 工作区快照的持久化。
 *
 * 只保存能重建工作现场的最小集合：标签、最后活动的标签、以及每个 SQL 标签的
 * 草稿文本。**不保存查询结果**——结果可以重新执行得到，写进 localStorage 只会
 * 撑爆配额，并且让用户看到一份可能早已过期的数据。
 */

import type { ClosedWorkspaceTab, WorkspaceTab } from '../contracts/workspace';
import { useQueryStore } from '../stores/queryStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

const STORAGE_KEY = 'dataomni_workspace';
const SNAPSHOT_VERSION = 1;

/**
 * 读到的快照来自更新的版本：这一版不认得它的格式，也就不往回写。
 *
 * 不然退回旧版启动一次，首帧的空工作区就把新版的标签与草稿整份盖掉，再升回去也找不回来。
 * 读总在写之前（`restoreWorkspaceFromSnapshot` 在渲染前调用），所以记在模块里就够了
 */
let newerSnapshotOnDisk = false;

export interface WorkspaceSnapshot {
  version: number;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** 标签 id -> SQL 草稿文本 */
  drafts: Record<string, string>;
  /**
   * 最近关闭但要求保留的标签。
   *
   * 作为可选字段加入，**没有提升 SNAPSHOT_VERSION**：升版本会让现有的 v1
   * 快照整份被丢弃，用户正开着的标签全没。缺这个字段时按空数组处理即可。
   */
  closedTabs: ClosedWorkspaceTab[];
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
  if (
    tab.kind !== 'sql'
    && tab.kind !== 'table-data'
    && tab.kind !== 'table-structure'
    && tab.kind !== 'er-diagram'
    && tab.kind !== 'ai-design'
  ) {
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

  // 表标签必须带得回它指向的对象，否则恢复出来是个打不开的空壳。
  // SQL 与 ER 图没有绑定对象：前者带草稿，后者画的是整个库。
  if (tab.kind === 'table-data' || tab.kind === 'table-structure') {
    const object = (tab as { object?: { table?: unknown } }).object;
    if (typeof object !== 'object' || object === null || typeof object.table !== 'string') {
      return false;
    }
  }

  return true;
}

function normalizeTab(tab: WorkspaceTab): WorkspaceTab {
  // 来源文件缺了哪一项就当没有：⌘S 退回「选路径」，而不是拿半个链接去写
  if (tab.kind === 'sql' && tab.file !== undefined
    && (typeof tab.file?.path !== 'string' || typeof tab.file?.contentHash !== 'string')) {
    const withoutFile = { ...tab };
    delete withoutFile.file;
    return normalizeTab(withoutFile);
  }
  // 会话是运行期的东西，重启后一律作废，由重新连接重建
  return {
    ...tab,
    // 旧快照没有 pinned 字段，归一成布尔值
    pinned: tab.pinned === true,
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
  newerSnapshotOnDisk = typeof snapshot.version === 'number' && snapshot.version > SNAPSHOT_VERSION;
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

  const closedTabs = Array.isArray(snapshot.closedTabs)
    ? snapshot.closedTabs.filter((closed): closed is ClosedWorkspaceTab => (
        typeof closed === 'object'
        && closed !== null
        && isWorkspaceTab((closed as ClosedWorkspaceTab).tab)
        && typeof (closed as ClosedWorkspaceTab).draft === 'string'
      )).map((closed) => ({ ...closed, tab: normalizeTab(closed.tab) }))
    : [];

  return {
    version: SNAPSHOT_VERSION,
    tabs,
    activeTabId,
    drafts,
    closedTabs,
    savedAt: typeof snapshot.savedAt === 'string' ? snapshot.savedAt : new Date().toISOString()
  };
}

export function saveWorkspaceSnapshot(
  snapshot: Omit<WorkspaceSnapshot, 'version' | 'savedAt'>
): void {
  if (newerSnapshotOnDisk) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SNAPSHOT_VERSION,
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      drafts: snapshot.drafts,
      closedTabs: snapshot.closedTabs,
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
 * 快照写入的防抖间隔。
 *
 * 草稿在编辑器里每敲一个键就变一次，而一次写入是把全部标签和草稿整份 `JSON.stringify`
 * 再同步 `setItem`——跟着每个键跑，草稿越大打字越卡。停手半秒再写，崩溃时最多丢这半秒
 */
export const SNAPSHOT_DEBOUNCE_MS = 500;

/** 从两个 store 现取一份快照写出去。只有 SQL 标签有草稿 */
function saveCurrentWorkspaceSnapshot(): void {
  const { tabs, activeTabId, closedTabs } = useWorkspaceStore.getState();
  const { documents } = useQueryStore.getState();
  const drafts: Record<string, string> = {};
  for (const tab of tabs) {
    const draft = documents[tab.id];
    if (tab.kind === 'sql' && draft) {
      drafts[tab.id] = draft.sqlInput;
    }
  }
  saveWorkspaceSnapshot({ tabs, activeTabId, drafts, closedTabs });
}

export interface WorkspaceSnapshotWatcher {
  /** 有没写出去的改动就立刻写（关窗口之前调） */
  flush: () => void;
  /** 退订；没写出去的改动先写掉 */
  stop: () => void;
}

/**
 * 标签、活动标签、关闭的标签与草稿任一变化，防抖后写回快照。
 *
 * 直接订阅 store 而不是放在组件的 effect 里：放在 effect 里就得在组件里订阅全部草稿，
 * 根组件会跟着每个键重渲染一遍。恢复发生在 main.tsx 首次渲染之前，订阅之后才有写入，
 * 不会把上次的内容盖成空的
 */
export function watchWorkspaceSnapshot(delayMs = SNAPSHOT_DEBOUNCE_MS): WorkspaceSnapshotWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      saveCurrentWorkspaceSnapshot();
    }, delayMs);
  };

  const flush = () => {
    if (timer === null) {
      return;
    }
    clearTimeout(timer);
    timer = null;
    saveCurrentWorkspaceSnapshot();
  };

  const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (
      state.tabs !== previous.tabs
      || state.activeTabId !== previous.activeTabId
      || state.closedTabs !== previous.closedTabs
    ) {
      schedule();
    }
  });
  const unsubscribeQuery = useQueryStore.subscribe((state, previous) => {
    if (state.documents !== previous.documents) {
      schedule();
    }
  });

  return {
    flush,
    stop: () => {
      unsubscribeWorkspace();
      unsubscribeQuery();
      flush();
    }
  };
}

/**
 * 把上次的快照灌回 store。
 *
 * 在 React 渲染之前调用（见 main.tsx）：如果放到 effect 里，首帧的空工作区
 * 会先被保存 effect 写出去一次，把快照覆盖成空的。
 */
export function restoreWorkspaceFromSnapshot(): void {
  const snapshot = loadWorkspaceSnapshot();
  if (!snapshot || (snapshot.tabs.length === 0 && snapshot.closedTabs.length === 0)) {
    return;
  }

  useWorkspaceStore.getState().restoreTabs(
    snapshot.tabs,
    snapshot.activeTabId,
    snapshot.closedTabs
  );
  useQueryStore.getState().restoreDocuments(snapshot.drafts);
}
