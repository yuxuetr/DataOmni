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

/** 位图导出的倍率。2 倍是为了在高分屏上不糊；再高只是让文件变大。 */
export const PNG_SCALE = 2;

/**
 * SVG 文本转成可以直接塞进 `<img src>` 的 data URL。
 *
 * 用 `encodeURIComponent` 而不是 `btoa`：`btoa` 只吃 Latin-1，
 * 图里只要有一个中文表名就会抛 `InvalidCharacterError`。
 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 从 `canvas.toDataURL()` 的结果里取出 base64 正文，去掉 `data:...;base64,` 前缀 */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? '' : dataUrl.slice(comma + 1);
}

/**
 * libjpeg 能编的最长边（`JPEG_MAX_DIMENSION`）。WebKitGTK 上超过它 `toDataURL` 给的是 `data:,`，
 * 日志里是 Maximum supported image dimension is 65500 pixels。PNG 没有这个限制（68072 高照样出）
 */
export const JPEG_MAX_SIDE = 65500;

/** 光栅化的倍率：照 `preferred` 放大，但最长边不超过 `maxSide`——宁可糊一点，也要画得出来 */
export function rasterScale(width: number, height: number, preferred: number, maxSide: number): number {
  const longest = Math.max(width, height, 1);
  return Math.min(preferred, maxSide / longest);
}

/**
 * 从 `toDataURL` 的结果里取正文，编码失败时报错。
 *
 * 画布编不出来时浏览器不抛错，给的是 `data:,`（或者退回 PNG）：不查的话写出去的是一个空文件，
 * 界面上还说「已导出」
 */
export function rasterPayload(dataUrl: string, type: string): string {
  const payload = dataUrlToBase64(dataUrl);
  if (!dataUrl.startsWith(`data:${type}`) || payload === '') {
    throw new Error('SVG_RASTERIZE_FAILED');
  }
  return payload;
}

/**
 * 把 SVG 光栅化成 PNG，返回 base64 正文。
 *
 * 走 `<img>` + canvas：SVG 必须是自包含的（颜色已内联、没有外部引用），
 * 否则画出来是一张白纸。data URL 不会污染 canvas，所以 `toDataURL` 可用。
 */
export async function rasterizeSvgToPngBase64(
  svg: string,
  width: number,
  height: number,
  scale: number = PNG_SCALE
): Promise<string> {
  return rasterPayload(await rasterizeSvg(svg, width, height, scale, 'image/png'), 'image/png');
}

/**
 * PDF 内嵌用 JPEG：`/DCTDecode` 可以把 JPEG 字节**原样**放进去，不需要在
 * 浏览器里做 zlib 压缩。原始 RGB 走 `/FlateDecode` 虽然无损，但要依赖
 * `CompressionStream`，而它在较旧的 WebKit 上没有——退化成不压缩的话，
 * 一张图就是十几 MB。
 */
export async function rasterizeSvgToJpegBytes(
  svg: string,
  width: number,
  height: number,
  scale: number = PNG_SCALE,
  quality = 0.95
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const fitted = rasterScale(width, height, scale, JPEG_MAX_SIDE);
  const dataUrl = await rasterizeSvg(svg, width, height, fitted, 'image/jpeg', quality);
  const binary = atob(rasterPayload(dataUrl, 'image/jpeg'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return {
    bytes,
    width: Math.max(1, Math.round(width * fitted)),
    height: Math.max(1, Math.round(height * fitted))
  };
}

async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
  scale: number,
  type: 'image/png' | 'image/jpeg',
  quality?: number
): Promise<string> {
  const image = new Image();
  image.src = svgToDataUrl(svg);

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    // 不给 onerror 的话，SVG 有问题时这个 Promise 永远不会 settle，
    // 界面卡在「导出中」而没有任何线索
    image.onerror = () => reject(new Error('SVG_RASTERIZE_FAILED'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('CANVAS_UNAVAILABLE');
  }
  // JPEG 不支持透明，未画背景的部分会变黑。导出的 SVG 自带背景矩形，
  // 但缩放取整可能在边缘留下一两个像素的空白，先铺一层底色兜住。
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL(type, quality);
}
