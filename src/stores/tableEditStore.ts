import { create } from 'zustand';
import type { PendingChange } from '../utils/pendingChanges';
import type { WorkspaceTab } from '../contracts/workspace';

/**
 * 每张表还没提交的改动。
 *
 * **为什么不放在组件里**：表标签切走就卸载。改了三行还没提交，去 SQL 标签看一眼
 * 再切回来，那三行就没了——没有提示，也没有撤销。实测过：切走前写着「1 项待提交」，
 * 切回来什么都不剩。SQL 标签的草稿早就放在 store 里（`queryStore.documents`），
 * 表标签只是没跟上。
 *
 * **按表存而不是按标签存**：改动的身份是「这张表的这几行」。同一张表在同一个
 * 连接下只会有一个标签（标签 id 本身就是按这个三元组去重的），两种存法一一对应；
 * 而按表存之后，「换表时改动的键指着另一张表」这种状态在结构上就不存在了，
 * 不需要再写一条清空来防它。
 *
 * **只活在内存里，不进工作区快照**：改动里存着这一行加载时的原值，用来显示
 * 「从什么改成什么」并判断哪几列真的变了。重启之后库里的行可能已经不是那个样子，
 * 拿一份过期的原值去比对，会得出一个错误的「这一列没变」，然后悄悄不发那条 SET。
 */
interface TableEditState {
  /** 表键 -> 待提交的改动 */
  changes: Record<string, PendingChange[]>;
  setChanges: (
    key: string,
    next: PendingChange[] | ((current: PendingChange[]) => PendingChange[])
  ) => void;
  clearChanges: (key: string) => void;
}

/**
 * 表的身份键。
 *
 * 导出出来是因为有两处要算它：表视图自己，以及关标签时负责清掉的 App。
 * 两边各写一遍迟早会写岔，而写岔的后果是关掉标签之后改动还留在内存里。
 */
export function tableEditKey(
  connectionId: string,
  schema: string | null | undefined,
  table: string
): string {
  return `${connectionId}:${schema ?? ''}:${table}`;
}

function without(
  changes: Record<string, PendingChange[]>,
  key: string
): Record<string, PendingChange[]> {
  if (!(key in changes)) {
    return changes;
  }
  const next = { ...changes };
  delete next[key];
  return next;
}

export const useTableEditStore = create<TableEditState>((set) => ({
  changes: {},

  setChanges: (key, next) => {
    set((state) => {
      const current = state.changes[key] ?? [];
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved.length === 0) {
        // 空数组不留在表里：否则关过的表会一直攒着一个空条目
        return { changes: without(state.changes, key) };
      }
      return { changes: { ...state.changes, [key]: resolved } };
    });
  },

  clearChanges: (key) => {
    set((state) => ({ changes: without(state.changes, key) }));
  }
}));

/** 这张表此刻有几项待提交。关标签前要问一句，靠它。 */
export function pendingChangeCount(key: string): number {
  return useTableEditStore.getState().changes[key]?.length ?? 0;
}

/**
 * 这个标签指着哪张表；不是表标签就是 null。
 *
 * 数据页和结构页是两个标签，但指的是**同一张表**，所以它们共用同一份待提交
 * 改动——结构页里切到「数据」也能改行。于是关掉其中一个时不能直接清：得等
 * 这张表的最后一个标签关掉。
 */
export function tableKeyOfTab(tab: WorkspaceTab): string | null {
  if (tab.kind !== 'table-data' && tab.kind !== 'table-structure') {
    return null;
  }
  return tableEditKey(tab.binding.profileId, tab.object.schema, tab.object.table);
}

/** 关掉 `closingTabId` 之后，这张表就再没有标签开着了 */
export function isLastTabForTable(
  tabs: readonly WorkspaceTab[],
  closingTabId: string
): boolean {
  const closing = tabs.find((tab) => tab.id === closingTabId);
  const key = closing ? tableKeyOfTab(closing) : null;
  if (!key) {
    return false;
  }
  return !tabs.some((tab) => tab.id !== closingTabId && tableKeyOfTab(tab) === key);
}
