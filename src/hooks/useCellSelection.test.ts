/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { isTextEntry } from './useCellSelection';

describe('网格让出按键', () => {
  it('输入框、文本域、下拉框、可编辑区域里的按键归它们自己', () => {
    // 回归：行编辑时方向键挪不了光标、⌘A 选中的是整张网格
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTextEntry(document.createElement(tag))).toBe(true);
    }
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    expect(isTextEntry(editable)).toBe(true);
  });

  it('格子本身、按钮上的按键仍归网格', () => {
    expect(isTextEntry(document.createElement('td'))).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
