/**
 * 把页面上的 SVG 导成一份能独立打开的文件。
 *
 * 图上的颜色全部来自 Tailwind 类（`fill-surface`、`stroke-line`…），而类名
 * 依赖应用的样式表。直接把 `outerHTML` 存下来，在浏览器或看图软件里打开
 * 就是一张黑白线框——**导出的东西必须自己带着样式**。
 *
 * 做法是把每个元素**当前计算出来的**颜色写成行内属性。这样导出的是「你此刻
 * 看到的样子」，包括深色模式。
 */
const PAINT_PROPERTIES = ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'opacity'] as const;
const TEXT_PROPERTIES = ['font-size', 'font-family', 'font-weight', 'text-anchor'] as const;

export interface SvgExportOptions {
  /** 背景色。SVG 默认透明，放进白底文档里深色主题的文字会看不见 */
  background: string;
  width: number;
  height: number;
}

export function serializeSvgWithInlineStyles(
  source: SVGSVGElement,
  options: SvgExportOptions
): string {
  const clone = source.cloneNode(true) as SVGSVGElement;

  // 克隆出来的节点不在文档里，拿不到计算样式，所以要拿原树和克隆树一一对应
  const originals = [source, ...Array.from(source.querySelectorAll('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))];

  originals.forEach((original, index) => {
    const target = clones[index];
    if (!(target instanceof SVGElement) || !(original instanceof SVGElement)) {
      return;
    }

    const computed = window.getComputedStyle(original);
    for (const property of [...PAINT_PROPERTIES, ...TEXT_PROPERTIES]) {
      const value = computed.getPropertyValue(property);
      if (value && value !== 'none' && value !== 'normal') {
        target.setAttribute(property, value);
      }
    }
    // 类名在导出的文件里没有意义，留着只会让文件变大
    target.removeAttribute('class');
  });

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(options.width));
  clone.setAttribute('height', String(options.height));
  clone.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);
  // 平移只是屏幕上的视图状态，导出的图不该带着它
  clone.removeAttribute('style');

  const background = `<rect width="100%" height="100%" fill="${options.background}"/>`;
  const body = clone.innerHTML;
  const attributes = Array.from(clone.attributes)
    .map(attribute => `${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg ${attributes}>${background}${body}</svg>\n`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 读一个 CSS 变量当前的值，用来给导出的图填背景 */
export function readCssColor(variable: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  return value || fallback;
}
