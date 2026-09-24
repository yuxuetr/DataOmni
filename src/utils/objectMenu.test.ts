import { describe, expect, it } from 'vitest';
import type { DatabaseObjectKind } from '../contracts/databaseMetadata';
import { isBrowsableKind } from './databaseObjects';
import { DESTRUCTIVE_MENU_ACTIONS, OBJECT_MENU_ACTIONS, objectMenuActions, qualifiedObjectName } from './objectMenu';
import { isDroppableKind } from './objectDdl';

const KINDS = Object.keys(OBJECT_MENU_ACTIONS) as DatabaseObjectKind[];

describe('每种对象右键能做什么', () => {
  it('没有哪一种右键出来是空的', () => {
    // 空菜单比没有菜单更糟：右键弹出一个空框，看上去像坏了
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].length, `${kind} 的菜单是空的`).toBeGreaterThan(0);
    }
  });

  it('「打开数据」当且仅当这种对象有行', () => {
    // 和 isBrowsableKind 是两处写法，对不上就会出现一个点下去必然查询失败的条目
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].includes('open-data'), kind).toBe(isBrowsableKind(kind));
    }
  });

  it('每种对象恰好有一条看它是什么的路', () => {
    // 表走结构页（顺带给列、索引、外键），其余走定义弹窗。两条都没有的那一种
    // 就是此前的视图：它的 SELECT 原文在界面上根本读不到
    for (const kind of KINDS) {
      const actions = OBJECT_MENU_ACTIONS[kind];
      const paths = Number(actions.includes('open-structure')) + Number(actions.includes('view-definition'));
      expect(paths, `${kind} 有 ${paths} 条看定义的路`).toBe(1);
    }
  });

  it('「打开结构」只给表', () => {
    // 结构页是可编辑的编辑器，它不知道自己打开的是不是视图
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].includes('open-structure'), kind).toBe(kind === 'table' || kind === 'collection');
    }
  });

  it('每一种都能复制名字', () => {
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].includes('copy-name'), kind).toBe(true);
    }
  });

  it('「删除」当且仅当生成得出那条 DROP', () => {
    // 两处写法：菜单给了而 dropObjectSql 不认，点下去就是一条类型对不上的语句
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].includes('drop'), kind).toBe(isDroppableKind(kind));
    }
  });

  it('「清空」只给表', () => {
    for (const kind of KINDS) {
      expect(OBJECT_MENU_ACTIONS[kind].includes('truncate'), kind).toBe(kind === 'table');
    }
  });

  it('改库的几项排在最后', () => {
    // 菜单在它们前面画一道分隔线；夹在中间的话，分隔线下面会混进一条只读的动作
    for (const kind of KINDS) {
      const actions = OBJECT_MENU_ACTIONS[kind];
      const first = actions.findIndex((action) => DESTRUCTIVE_MENU_ACTIONS.has(action));
      if (first === -1) {
        continue;
      }
      expect(actions.slice(first).every((action) => DESTRUCTIVE_MENU_ACTIONS.has(action)), kind)
        .toBe(true);
    }
  });
});

describe('复制出来的限定名', () => {
  it('有 schema 时带上 schema', () => {
    expect(qualifiedObjectName({ name: 'users', schema: 'public', kind: 'table' }, 'postgresql'))
      .toBe('"public"."users"');
  });

  it('没有 schema 时只有名字', () => {
    expect(qualifiedObjectName({ name: 'users', schema: null, kind: 'table' }, 'sqlite')).toBe('"users"');
  });

  it('MySQL 用反引号', () => {
    expect(qualifiedObjectName({ name: 'users', schema: 'shop', kind: 'table' }, 'mysql')).toBe('`shop`.`users`');
  });

  it('关键字和空格都能直接粘进 SQL', () => {
    // 复制裸名字没有用，要的是能直接粘的那一串
    expect(qualifiedObjectName({ name: 'order', schema: null, kind: 'table' }, 'postgresql')).toBe('"order"');
    expect(qualifiedObjectName({ name: 'My Table', schema: null, kind: 'table' }, 'postgresql')).toBe('"My Table"');
  });

  it('函数的参数签名留在引号外', () => {
    // 显示名是 `calc_total(integer)`，整串引起来会变成一个「名字里带括号的
    // 函数」，粘进 SQL 必然报错。这条是渲染出来看的时候发现的
    expect(qualifiedObjectName(
      { name: 'calc_total(integer)', schema: 'public', kind: 'function' },
      'postgresql'
    )).toBe('"public"."calc_total"(integer)');
  });

  it('存储过程同理', () => {
    expect(qualifiedObjectName(
      { name: 'do_thing(text, integer)', schema: 'app', kind: 'procedure' },
      'postgresql'
    )).toBe('"app"."do_thing"(text, integer)');
  });

  it('无参函数也拆得对', () => {
    expect(qualifiedObjectName(
      { name: 'now_ish()', schema: null, kind: 'function' },
      'postgresql'
    )).toBe('"now_ish"()');
  });

  it('名字里带括号的表不许被拆', () => {
    // 按 kind 拆而不是看有没有括号：表真的可以叫这个名字
    expect(qualifiedObjectName(
      { name: 'weird(name)', schema: null, kind: 'table' },
      'postgresql'
    )).toBe('"weird(name)"');
  });

  it('名字里自带引号时转义，不会把语句截断', () => {
    expect(qualifiedObjectName({ name: 'we"ird', schema: null, kind: 'table' }, 'postgresql')).toBe('"we""ird"');
  });
});

describe('不走 SQL 的连接上', () => {
  it('只有打开、结构与复制：MongoDB 的视图也叫 view，而查看定义、删除是拼 SQL 做的', () => {
    // 视图的定义在它的结构页里，所以视图也有「打开结构」
    expect(objectMenuActions('view', false)).toEqual(['open-data', 'open-structure', 'copy-name']);
    expect(objectMenuActions('collection', false)).toEqual(['open-data', 'open-structure', 'copy-name']);
    // 反向：SQL 连接上的视图照旧
    expect(objectMenuActions('view', true)).toEqual(OBJECT_MENU_ACTIONS.view);
  });
});
