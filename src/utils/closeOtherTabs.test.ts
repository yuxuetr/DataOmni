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
      (tab) => tab.id === 'edited',
      10
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

  it('「最近关闭」放不下的草稿留着不关，不被挤掉', () => {
    // 「最近关闭」只留最近的几条。一次关掉的草稿比它能放的多，最先关的那些
    // 会被后面的挤出去——草稿就此没了，而这个操作承诺的是不丢东西
    const drafts = Array.from({ length: 4 }, (_, index) =>
      createSqlWorkspaceTab('p', { id: `d${index}` })
    );
    const plan = planCloseOthers([keep, ...drafts, clean], 'keep', (tab) => tab.id.startsWith('d'), () => false, 2);
    expect(plan.close).toEqual([
      { id: 'd0', retainDraft: true },
      { id: 'd1', retainDraft: true },
      { id: 'clean', retainDraft: false }
    ]);
    expect(plan.kept).toEqual(['d2', 'd3']);
  });
});
