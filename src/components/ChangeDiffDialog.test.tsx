/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import type { PendingChange } from '../utils/pendingChanges';
import { ChangeDiffDialog, type CommitFailure } from './ChangeDiffDialog';

const TARGET = { schema: null, table: 't', columns: [], dialect: 'postgresql' as const };

const insertOf = (id: string, name: string): PendingChange => ({
  id,
  kind: 'insert',
  values: { name: { kind: 'value', value: name } }
});

let container: HTMLDivElement;
let root: Root;

async function render(changes: PendingChange[], failure: CommitFailure | null) {
  await act(async () => {
    root.render(
      <ChangeDiffDialog
        changes={changes}
        target={TARGET}
        committing={false}
        failure={failure}
        onRevert={() => {}}
        onRevertAll={() => {}}
        onCommit={() => {}}
        onClose={() => {}}
      />
    );
  });
}

/** 标着错误的那几条改动里写的值 */
const markedValues = () => [...container.querySelectorAll('li')]
  .filter((item) => item.textContent?.includes('violates foreign key'))
  .map((item) => (item.textContent?.includes('first') ? 'first' : 'second'));

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

describe('ChangeDiffDialog 的失败标记', () => {
  const failure: CommitFailure = {
    changeId: 'a',
    error: { message: 'violates foreign key constraint' }
  };

  it('标在出错的那一条上', async () => {
    await render([insertOf('a', 'first'), insertOf('b', 'second')], failure);
    expect(markedValues()).toEqual(['first']);
  });

  it('撤掉出错的那一条后，错误不挪到顶上来的另一条', async () => {
    // 此前按下标记：撤掉第一条，第二条顶到下标 0，于是被标上第一条的外键错误
    await render([insertOf('b', 'second')], failure);
    expect(markedValues()).toEqual([]);
  });
});
