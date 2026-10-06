/**
 * WebView 自带的右键菜单什么时候留着。
 *
 * 没有自己菜单的地方，WebKitGTK 与 WKWebView 弹的是浏览器那一份：后退、前进、停止、重新加载。
 * 点了「重新加载」整个前端重来，排队没提交的改动、跑出来的结果都没了。输入框与编辑器里那一份
 * 是剪切、复制、粘贴，选中文字时是复制——这两处留着，其余的不弹
 */
export function keepsNativeContextMenu(target: EventTarget | null, selectedText: string): boolean {
  if (selectedText.length > 0) {
    return true;
  }
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null;
}

/** 只装在打包版上：开发时右键还要留给「检查元素」 */
export function installNativeContextMenuGuard(): void {
  window.addEventListener('contextmenu', (event) => {
    if (!keepsNativeContextMenu(event.target, window.getSelection()?.toString() ?? '')) {
      event.preventDefault();
    }
  });
}
