/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { keepsNativeContextMenu } from './nativeContextMenu';

function element(html: string, selector: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const found = host.querySelector(selector);
  if (!found) throw new Error(selector);
  return found;
}

describe('keepsNativeContextMenu', () => {
  it('空白处与按钮上不给：WebView 自带的那一份只有后退、前进、重新加载', () => {
    // 点了「重新加载」，排队的改动、结果和表格状态全没了
    expect(keepsNativeContextMenu(element('<main><p>x</p></main>', 'p'), '')).toBe(false);
    expect(keepsNativeContextMenu(element('<button><span>run</span></button>', 'span'), '')).toBe(false);
    expect(keepsNativeContextMenu(null, '')).toBe(false);
  });

  it('输入框、文本域与可编辑区域里照给：剪切、复制、粘贴在那里', () => {
    expect(keepsNativeContextMenu(element('<input />', 'input'), '')).toBe(true);
    expect(keepsNativeContextMenu(element('<textarea></textarea>', 'textarea'), '')).toBe(true);
    // CodeMirror 的编辑区是 contenteditable，点在里面的某一行上
    expect(keepsNativeContextMenu(
      element('<div contenteditable="true"><div class="line"><span>SELECT</span></div></div>', 'span'),
      ''
    )).toBe(true);
    expect(keepsNativeContextMenu(element('<div contenteditable="false"><span>x</span></div>', 'span'), '')).toBe(false);
  });

  it('选中了文字时照给：要的是「复制」', () => {
    expect(keepsNativeContextMenu(element('<p>error message</p>', 'p'), 'error')).toBe(true);
  });
});
