/**
 * 需要 DOM：断言的错误文案走 i18n，而 store 在加载时会写 <html lang>。
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { assertSingleRowAffected } from './executeResult';
import { useLanguageStore } from '../stores/languageStore';

beforeEach(() => {
  useLanguageStore.getState().setPreference('zh');
});

describe('assertSingleRowAffected', () => {
  it('accepts exactly one affected row', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 1 }, '更新')).not.toThrow();
  });

  it('rejects a missing target row', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 0 }, '更新')).toThrow(
      '目标记录不存在或已被其他操作修改'
    );
  });

  it('rejects updates affecting multiple rows', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 2 }, '删除')).toThrow(
      '预期影响 1 行，实际影响 2 行'
    );
  });

  it('错误文案跟着界面语言走，不是写死的中文', () => {
    // 这是唯一一处「抛出的错误本身要被翻译」的地方：它在 React 之外，
    // 但抛出后立刻就拿去显示，所以取当下的语言是对的
    useLanguageStore.getState().setPreference('en');
    expect(() => assertSingleRowAffected({ rowsAffected: 0 }, 'update')).toThrow(
      'the target row does not exist'
    );
    expect(() => assertSingleRowAffected({ rowsAffected: 3 }, 'delete')).toThrow(
      'expected 1 row to be affected, but 3 were'
    );
  });
});
