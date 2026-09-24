import type { WorkspaceTab } from '../contracts/workspace';

export interface CloseOthersPlan {
  /** 要关的标签；`retainDraft` 为真的进「最近关闭」，能重新打开 */
  close: Array<{ id: string; retainDraft: boolean }>;
  /** 因为有没提交的表格改动而留着的 */
  kept: string[];
}

/**
 * 「关闭其他标签」关哪些、怎么关。
 *
 * 一次关一串，就不能像关单个标签那样逐个弹框问。所以只做**不丢东西**的那一半：
 * 固定的标签不动（固定就是为了不被批量关掉）；SQL 草稿进「最近关闭」，
 * 按 ⇧⌘T 还能拿回来；表格上没提交的改动没有地方可存，那个标签就留着。
 */
export function planCloseOthers(
  tabs: readonly WorkspaceTab[],
  keepId: string,
  hasUnsavedDraft: (tab: WorkspaceTab) => boolean,
  hasPendingChanges: (tab: WorkspaceTab) => boolean
): CloseOthersPlan {
  const plan: CloseOthersPlan = { close: [], kept: [] };
  for (const tab of tabs) {
    if (tab.id === keepId || tab.pinned) {
      continue;
    }
    if (hasPendingChanges(tab)) {
      plan.kept.push(tab.id);
      continue;
    }
    plan.close.push({ id: tab.id, retainDraft: tab.kind === 'sql' && hasUnsavedDraft(tab) });
  }
  return plan;
}
