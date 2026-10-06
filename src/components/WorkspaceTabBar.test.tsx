/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqlWorkspaceTab } from '../contracts/workspace';
import { useLanguageStore } from '../stores/languageStore';
import { WorkspaceTabBar } from './WorkspaceTabBar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WorkspaceTabBar', () => {
  // 回归时看到的：标签一多，「新建 / 打开文件 / 重新打开」跟着标签一起滚出了视野
  it('新建、打开、重新打开不在滚动的那一段里', () => {
    const tab = createSqlWorkspaceTab('p1', { id: 't1' });
    const noop = () => undefined;
    act(() => {
      root.render(
        <WorkspaceTabBar
          tabs={[tab]}
          activeTabId="t1"
          activeProfileId="p1"
          unsavedTabIds={new Set()}
          environmentByProfileId={{}}
          onActivate={noop}
          onClose={noop}
          onContextMenu={noop}
          onNewSqlTab={noop}
          onOpenSqlFile={noop}
          onReopenClosedTab={noop}
          closedTabCount={1}
        />
      );
    });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.querySelectorAll('[role="tab"]').length).toBe(1);
    for (const label of ['New query tab', 'Open a .sql file', 'Reopen the last closed tab']) {
      const button = container.querySelector(`button[aria-label="${label}"]`);
      expect(button, label).not.toBeNull();
      expect(tablist?.contains(button), label).toBe(false);
    }
  });
});
