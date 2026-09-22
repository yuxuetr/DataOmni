import { describe, expect, it } from 'vitest';
import { MAX_RENDERED_TREE_ITEMS, type DatabaseObject, type ObjectTreeNode } from './databaseObjects';
import { flattenVisibleTree, objectNodeKey, treeKeyAction } from './treeNavigation';

function object(name: string): DatabaseObject {
  return { schema: 'public', name, kind: 'table', id: name };
}

/** PostgreSQL 的形状：schema 一层，下面按类型分组，再下面是对象 */
const TREE: ObjectTreeNode[] = [
  {
    key: 'schema:public',
    label: 'public',
    objects: [object('orders'), object('users')],
    children: [
      { key: 'public:kind:table', label: '表', objects: [object('orders'), object('users')] }
    ]
  },
  {
    key: 'schema:billing',
    label: 'billing',
    objects: [object('invoices')],
    children: [
      { key: 'billing:kind:table', label: '表', objects: [object('invoices')] }
    ]
  }
];

const expandedAll = () => true;
const expandedNone = () => false;

describe('把树压成看得见的序列', () => {
  it('全收起来时只剩顶层', () => {
    expect(flattenVisibleTree(TREE, expandedNone).map((node) => node.key))
      .toEqual(['schema:public', 'schema:billing']);
  });

  it('全展开时按屏幕上的先后排', () => {
    expect(flattenVisibleTree(TREE, expandedAll).map((node) => node.key)).toEqual([
      'schema:public',
      'public:kind:table',
      objectNodeKey(object('orders')),
      objectNodeKey(object('users')),
      'schema:billing',
      'billing:kind:table',
      objectNodeKey(object('invoices'))
    ]);
  });

  it('只展开一个 schema 时，另一个下面的节点不在序列里', () => {
    const flat = flattenVisibleTree(TREE, (key) => key !== 'schema:billing');
    expect(flat.map((node) => node.key)).toContain('public:kind:table');
    expect(flat.map((node) => node.key)).not.toContain('billing:kind:table');
  });

  it('层级从 1 开始，对应 aria-level', () => {
    const flat = flattenVisibleTree(TREE, expandedAll);
    expect(flat[0].level).toBe(1);
    expect(flat[1].level).toBe(2);
    expect(flat[2].level).toBe(3);
  });

  it('父子关系记下来，左键才退得回去', () => {
    const flat = flattenVisibleTree(TREE, expandedAll);
    expect(flat[0].parentKey).toBeNull();
    expect(flat[1].parentKey).toBe('schema:public');
    expect(flat[2].parentKey).toBe('public:kind:table');
  });

  /**
   * 键盘走得到的必须是画得出来的。渲染按 `MAX_RENDERED_TREE_ITEMS` 截断，
   * 压平这里不跟着截，焦点就会落到一个不存在的节点上——看上去是凭空消失
   */
  it('对象那一层和渲染用同一个上限', () => {
    const many: ObjectTreeNode[] = [{
      key: 'kind:table',
      label: '表',
      objects: Array.from({ length: 5000 }, (_, index) => object(`t_${index}`))
    }];
    const flat = flattenVisibleTree(many, expandedAll);
    // 1 个分组标题 + 上限个对象
    expect(flat).toHaveLength(1 + MAX_RENDERED_TREE_ITEMS);
  });
});

describe('对象树按一次键之后做什么', () => {
  const flat = flattenVisibleTree(TREE, expandedAll);
  const collapsed = flattenVisibleTree(TREE, expandedNone);

  it('上下键在看得见的序列里走', () => {
    expect(treeKeyAction('ArrowDown', flat, 'schema:public'))
      .toEqual({ kind: 'focus', key: 'public:kind:table' });
    expect(treeKeyAction('ArrowUp', flat, 'public:kind:table'))
      .toEqual({ kind: 'focus', key: 'schema:public' });
  });

  it('两头**不**回绕：树是有上下文的，从最后一个跳回第一个会让人丢失位置', () => {
    const last = flat[flat.length - 1].key;
    expect(treeKeyAction('ArrowDown', flat, last)).toEqual({ kind: 'focus', key: last });
    expect(treeKeyAction('ArrowUp', flat, flat[0].key))
      .toEqual({ kind: 'focus', key: flat[0].key });
  });

  it('右键：收着就展开，已经展开就走进第一个孩子', () => {
    expect(treeKeyAction('ArrowRight', collapsed, 'schema:public'))
      .toEqual({ kind: 'expand', key: 'schema:public' });
    expect(treeKeyAction('ArrowRight', flat, 'schema:public'))
      .toEqual({ kind: 'focus', key: 'public:kind:table' });
  });

  it('左键：展开着就收起，收起了就退到父节点', () => {
    expect(treeKeyAction('ArrowLeft', flat, 'schema:public'))
      .toEqual({ kind: 'collapse', key: 'schema:public' });
    expect(treeKeyAction('ArrowLeft', flat, objectNodeKey(object('orders'))))
      .toEqual({ kind: 'focus', key: 'public:kind:table' });
  });

  it('一路按左键能退到顶层，不会卡在某一层', () => {
    // 对象 → 类型分组 → schema，再按就没有父节点了
    expect(treeKeyAction('ArrowLeft', collapsed, 'schema:public')).toBeNull();
  });

  it('叶子节点按右键什么也不做，不要吃掉这个键', () => {
    expect(treeKeyAction('ArrowRight', flat, objectNodeKey(object('users')))).toBeNull();
  });

  it('Home / End 到两端', () => {
    expect(treeKeyAction('Home', flat, flat[3].key)).toEqual({ kind: 'focus', key: flat[0].key });
    expect(treeKeyAction('End', flat, flat[0].key))
      .toEqual({ kind: 'focus', key: flat[flat.length - 1].key });
  });

  it('回车与空格是「打开它」', () => {
    const key = objectNodeKey(object('orders'));
    expect(treeKeyAction('Enter', flat, key)).toEqual({ kind: 'activate', key });
    expect(treeKeyAction(' ', flat, key)).toEqual({ kind: 'activate', key });
  });

  it('焦点还没落下时，方向键先把它放到第一个', () => {
    expect(treeKeyAction('ArrowDown', flat, null)).toEqual({ kind: 'focus', key: flat[0].key });
    expect(treeKeyAction('ArrowRight', flat, null)).toEqual({ kind: 'focus', key: flat[0].key });
  });

  it('不归对象树管的键返回 null', () => {
    for (const key of ['a', 'Tab', 'Escape', 'PageDown', 'Delete']) {
      expect(treeKeyAction(key, flat, flat[0].key), key).toBeNull();
    }
  });

  it('空树上按什么都不做', () => {
    expect(treeKeyAction('ArrowDown', [], null)).toBeNull();
  });
});
