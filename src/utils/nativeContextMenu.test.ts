/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { installNativeContextMenuGuard, keepsNativeContextMenu } from './nativeContextMenu';

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

/**
 * R7-mac 看到的：在连接列表的「r7-pg」上右键，弹的是「查询 "pg"」「翻译」「用必应搜索」。
 * macOS 上右键会先把指针下那个词选中，等 contextmenu 到的时候已经「选中了文字」
 * ——判断要看按下右键**之前**有没有选区
 */
describe('installNativeContextMenuGuard', () => {
  installNativeContextMenuGuard();

  function rightClick(target: Element, selectWordOnPress: boolean): boolean {
    target.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    if (selectWordOnPress) {
      window.getSelection()?.selectAllChildren(target);
    }
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    window.getSelection()?.removeAllRanges();
    return event.defaultPrevented;
  }

  function paragraph(): Element {
    const p = document.createElement('p');
    p.textContent = 'r7-pg';
    document.body.appendChild(p);
    return p;
  }

  it('右键时系统顺手选中的词不算「选中了文字」', () => {
    expect(rightClick(paragraph(), true)).toBe(true);
  });

  it('右键之前就选好的文字照给系统菜单', () => {
    const p = paragraph();
    window.getSelection()?.selectAllChildren(p);
    p.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    p.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
