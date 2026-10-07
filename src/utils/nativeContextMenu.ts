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

/**
 * 只装在打包版上：开发时右键还要留给「检查元素」。
 *
 * 选区要取**按下右键之前**的：macOS 上右键会先把指针下那个词选中，contextmenu 到的时候
 * 总是「选中了文字」，于是列表行上弹出「查询」「翻译」「用必应搜索」。捕获阶段的 mousedown
 * 先于 WebKit 选词。键盘唤出的菜单没有 mousedown，取当时的选区
 */
export function installNativeContextMenuGuard(): void {
  let selectionBeforePress: string | null = null;
  window.addEventListener('mousedown', (event) => {
    if (event.button === 2) {
      selectionBeforePress = window.getSelection()?.toString() ?? '';
    }
  }, true);
  window.addEventListener('contextmenu', (event) => {
    const selectedText = selectionBeforePress ?? window.getSelection()?.toString() ?? '';
    selectionBeforePress = null;
    if (!keepsNativeContextMenu(event.target, selectedText)) {
      event.preventDefault();
    }
  });
}
