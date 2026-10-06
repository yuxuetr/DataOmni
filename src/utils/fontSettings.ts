import { getCurrentWebview } from '@tauri-apps/api/webview';

/**
 * 界面字体、代码编辑器的字体与字号、界面缩放。
 *
 * 两张数据网格的字体和字号**不在这里**：列宽按 13px 等宽字体的字宽估算
 * （`columnWidths.ts` 的 `charWidth`），换字体或字号每一列都会算错，表现只是
 * 「有些列被截断了」。要整体放大就用界面缩放——那是在 CSS 像素之下整体放大，
 * 估算的单位跟着一起变，不会错。
 *
 * 字体名是自由填写的：WebView 不给列出本机装了哪些字体。填了没装的字体，
 * 浏览器按顺序往后找，最后落到默认那一组，不会变成方块。
 */
export interface FontSettings {
  /** 空串表示用系统默认 */
  uiFont: string;
  codeFont: string;
  codeFontSize: number;
  uiZoom: number;
}

export const CODE_FONT_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
export const UI_ZOOM_LEVELS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  uiFont: '',
  codeFont: '',
  codeFontSize: 14,
  uiZoom: 1
};

const STORAGE_KEY = 'dataomni.fonts';

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math'
]);

/**
 * 把输入框里的字体名写成 font-family 的值；什么都没填返回 `null`。
 *
 * 每个名字都加引号（`Fira Code` 不加引号也合法，但 `Source Code Pro 2` 这种
 * 带数字的就不合法了，整条声明作废），通用族名除外。分号、花括号、反斜杠
 * 去掉：这个值经 `setProperty` 写进去，它们能截断或转义这条声明。
 */
export function fontStack(input: string): string | null {
  const names = input
    .split(',')
    .map((name) => name.replace(/["'\\;{}]/g, '').trim())
    .filter((name) => name.length > 0)
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`));
  return names.length > 0 ? names.join(', ') : null;
}

export function normalizeFontSettings(raw: unknown): FontSettings {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_FONT_SETTINGS;
  }
  const value = raw as Record<string, unknown>;
  return {
    uiFont: typeof value.uiFont === 'string' ? value.uiFont : DEFAULT_FONT_SETTINGS.uiFont,
    codeFont: typeof value.codeFont === 'string' ? value.codeFont : DEFAULT_FONT_SETTINGS.codeFont,
    codeFontSize: CODE_FONT_SIZES.includes(value.codeFontSize as number)
      ? value.codeFontSize as number
      : DEFAULT_FONT_SETTINGS.codeFontSize,
    uiZoom: UI_ZOOM_LEVELS.includes(value.uiZoom as number)
      ? value.uiZoom as number
      : DEFAULT_FONT_SETTINGS.uiZoom
  };
}

export function loadFontSettings(): FontSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeFontSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_FONT_SETTINGS;
  }
}

export function saveFontSettings(settings: FontSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存储不可用时这一轮仍然生效，只是重启后回到默认
  }
}

/**
 * 写成 `<html>` 上的变量，`index.css` 与编辑器主题（`editorTheme.ts`）读它们。
 * 填的字体后面接上原来的默认那一组，没装的时候往后落。
 */
export function applyFontSettings(settings: FontSettings): void {
  if (typeof document === 'undefined') {
    return;
  }
  const style = document.documentElement.style;
  const uiFont = fontStack(settings.uiFont);
  const codeFont = fontStack(settings.codeFont);
  if (uiFont) {
    style.setProperty('--dm-ui-font', `${uiFont}, var(--font-sans)`);
  } else {
    style.removeProperty('--dm-ui-font');
  }
  if (codeFont) {
    style.setProperty('--dm-code-font', `${codeFont}, monospace`);
  } else {
    style.removeProperty('--dm-code-font');
  }
  style.setProperty('--dm-code-font-size', `${settings.codeFontSize}px`);
}

/** 缩放是 WebView 的，不是 CSS 的：CSS 的 `zoom` 会让鼠标坐标和元素位置对不上，右键菜单弹偏 */
export async function applyUiZoom(zoom: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(zoom);
  } catch (error) {
    console.warn('set webview zoom failed', error);
  }
}
