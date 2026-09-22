import { renderedTreeObjects, type DatabaseObject, type ObjectTreeNode } from './databaseObjects';

/**
 * 对象树的键盘导航。
 *
 * 整棵树只有一个 Tab 停靠点（roving tabindex），进来之后用方向键走。此前每个
 * 对象都是独立的 `<button>`，也就是独立的停靠点——单组上限 200，意味着最多
 * 按 200 次 Tab 才走得过这一组。
 *
 * 上下键走的是**屏幕上看得见的那些**，不是整棵树：收起来的分组里那些节点
 * 不在序列里。所以第一件事是按当前展开状态把树压平。
 */
export interface FlatTreeNode {
  /** 节点身份。分组用 `node.key`，对象用 `kind:id`——和渲染时的 React key 同源 */
  readonly key: string;
  /** 从 1 开始，对应 `aria-level` */
  readonly level: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly parentKey: string | null;
  /** 对象节点带上它自己，分组节点为 null——回车要拿它去打开 */
  readonly object: DatabaseObject | null;
}

export function objectNodeKey(object: DatabaseObject): string {
  return `${object.kind}:${object.id}`;
}

/**
 * 按当前展开状态压平。
 *
 * 对象那一层走 `renderedTreeObjects`，和渲染用的是同一个上限——不然键盘能
 * 走到一个画不出来的节点上，焦点看上去凭空消失。
 */
export function flattenVisibleTree(
  nodes: readonly ObjectTreeNode[],
  isExpanded: (key: string) => boolean,
  level = 1,
  parentKey: string | null = null
): FlatTreeNode[] {
  const flat: FlatTreeNode[] = [];

  for (const node of nodes) {
    const expanded = isExpanded(node.key);
    flat.push({
      key: node.key,
      level,
      expandable: true,
      expanded,
      parentKey,
      object: null
    });

    if (!expanded) {
      continue;
    }

    if (node.children) {
      flat.push(...flattenVisibleTree(node.children, isExpanded, level + 1, node.key));
      continue;
    }

    for (const object of renderedTreeObjects(node.objects).shown) {
      flat.push({
        key: objectNodeKey(object),
        level: level + 1,
        expandable: false,
        expanded: false,
        parentKey: node.key,
        object
      });
    }
  }

  return flat;
}

export type TreeAction =
  | { readonly kind: 'focus'; readonly key: string }
  | { readonly kind: 'expand'; readonly key: string }
  | { readonly kind: 'collapse'; readonly key: string }
  | { readonly kind: 'activate'; readonly key: string };

/**
 * 按一次键之后该做什么。返回 `null` 表示这个键不归对象树管——调用方据此决定
 * 不要 `preventDefault`，吃掉一个自己不处理的键等于把它从别处偷走。
 *
 * 左右键按 tree 模式的约定走，两个方向都不是单纯的「收/展」：
 * - 右：收着就展开；已经展开就走进第一个孩子。
 * - 左：展开着就收起；已经收起（或者根本不能展）就跳到父节点。
 *
 * 这样一路按左键能退到顶层，而不是卡在某一层上。
 */
export function treeKeyAction(
  key: string,
  flat: readonly FlatTreeNode[],
  focusedKey: string | null
): TreeAction | null {
  if (flat.length === 0) {
    return null;
  }

  const index = flat.findIndex((node) => node.key === focusedKey);
  // 焦点还没落在任何节点上时，方向键先把它放到第一个
  const current = index >= 0 ? flat[index] : null;

  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', key: flat[Math.min(index + 1, flat.length - 1)].key };
    case 'ArrowUp':
      return { kind: 'focus', key: flat[Math.max(index - 1, 0)].key };
    case 'Home':
      return { kind: 'focus', key: flat[0].key };
    case 'End':
      return { kind: 'focus', key: flat[flat.length - 1].key };
    case 'ArrowRight': {
      if (!current) {
        return { kind: 'focus', key: flat[0].key };
      }
      if (current.expandable && !current.expanded) {
        return { kind: 'expand', key: current.key };
      }
      const child = flat[index + 1];
      return child && child.parentKey === current.key
        ? { kind: 'focus', key: child.key }
        : null;
    }
    case 'ArrowLeft': {
      if (!current) {
        return { kind: 'focus', key: flat[0].key };
      }
      if (current.expandable && current.expanded) {
        return { kind: 'collapse', key: current.key };
      }
      return current.parentKey ? { kind: 'focus', key: current.parentKey } : null;
    }
    case 'Enter':
    case ' ':
      return current ? { kind: 'activate', key: current.key } : null;
    default:
      return null;
  }
}
