import { describe, expect, it } from 'vitest';
import { createSqlWorkspaceTab, createTableWorkspaceTab } from '../contracts/workspace';
import { planCloseOthers } from './closeOtherTabs';

const keep = createSqlWorkspaceTab('p', { id: 'keep' });
const pinned = { ...createSqlWorkspaceTab('p', { id: 'pinned' }), pinned: true };
const draft = createSqlWorkspaceTab('p', { id: 'draft' });
const empty = createSqlWorkspaceTab('p', { id: 'empty' });
const edited = createTableWorkspaceTab('p', 'users', { id: 'edited' });
const clean = createTableWorkspaceTab('p', 'orders', { id: 'clean' });

describe('关闭其他标签', () => {
  it('只做不丢东西的那一半', () => {
    const plan = planCloseOthers(
      [keep, pinned, draft, empty, edited, clean],
      'keep',
      (tab) => tab.id === 'draft',
      (tab) => tab.id === 'edited'
    );
    expect(plan.close).toEqual([
      // 草稿进「最近关闭」，能拿回来
      { id: 'draft', retainDraft: true },
      { id: 'empty', retainDraft: false },
      { id: 'clean', retainDraft: false }
    ]);
    // 表格上没提交的改动没处存，留着；固定的与当前的不在任何一边
    expect(plan.kept).toEqual(['edited']);
  });
});
