/**
 * 把一张位图包成 PDF。
 *
 * **为什么是位图而不是矢量**：矢量 PDF 的文字要靠 PDF 字体渲染，而基础 14 号
 * 字体只有 Latin-1——一个中文表名就会变成乱码或整个消失。要正确排中日韩文字
 * 就得随包嵌入一份字体，那是几 MB 的代价，为一个导出功能不划算。
 * 位图里文字已经画好了，什么语言都对。需要矢量的场景用 SVG 导出。
 *
 * 结构是最小的：目录 → 页面树 → 一页 → 一个图像 XObject + 一段内容流。
 * PDF 的交叉引用表存的是**字节偏移**，所以这里全程按字节拼，不按字符。
 */

const ENCODER = new TextEncoder();

export type PdfImageFilter = 'DCTDecode' | 'FlateDecode';

export interface SingleImagePdfOptions {
  image: Uint8Array;
  /** DCTDecode = JPEG 原样内嵌；FlateDecode = zlib 压过的原始 RGB */
  filter: PdfImageFilter;
  imageWidth: number;
  imageHeight: number;
  /** 页面尺寸，单位是点（1/72 英寸）。按 1 像素 = 1 点算，图多大页多大。 */
  pageWidth: number;
  pageHeight: number;
}

export function buildSingleImagePdf(options: SingleImagePdfOptions): Uint8Array {
  const { image, filter, imageWidth, imageHeight, pageWidth, pageHeight } = options;

  const content = ENCODER.encode(
    `q ${round(pageWidth)} 0 0 ${round(pageHeight)} 0 0 cm /Im0 Do Q\n`
  );

  const objects: Uint8Array[][] = [
    [ENCODER.encode('<< /Type /Catalog /Pages 2 0 R >>')],
    [ENCODER.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [
      ENCODER.encode(
        '<< /Type /Page /Parent 2 0 R '
          + `/MediaBox [0 0 ${round(pageWidth)} ${round(pageHeight)}] `
          + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
      )
    ],
    [
      ENCODER.encode(
        '<< /Type /XObject /Subtype /Image '
          + `/Width ${imageWidth} /Height ${imageHeight} `
          + '/ColorSpace /DeviceRGB /BitsPerComponent 8 '
          + `/Filter /${filter} /Length ${image.length} >>\nstream\n`
      ),
      image,
      ENCODER.encode('\nendstream')
    ],
    [
      ENCODER.encode(`<< /Length ${content.length} >>\nstream\n`),
      content,
      ENCODER.encode('\nendstream')
    ]
  ];

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.length;
  };

  // 第二行的高位字节注释：告诉传输工具这是二进制文件，不要做换行转换
  push(ENCODER.encode('%PDF-1.7\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const objectOffsets: number[] = [];
  objects.forEach((parts, index) => {
    objectOffsets.push(offset);
    push(ENCODER.encode(`${index + 1} 0 obj\n`));
    parts.forEach(push);
    push(ENCODER.encode('\nendobj\n'));
  });

  const xrefOffset = offset;
  const size = objects.length + 1;
  // 每条记录必须正好 20 字节，多一个少一个都会让阅读器算错位置
  const entries = [
    '0000000000 65535 f \n',
    ...objectOffsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`)
  ].join('');

  push(ENCODER.encode(`xref\n0 ${size}\n${entries}`));
  push(
    ENCODER.encode(
      `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    )
  );

  return concat(chunks);
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** 二进制转 base64，交给 `write_binary_file` */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 一次性 apply 整个数组会在几百 KB 时爆栈，所以分块
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
