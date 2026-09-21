import { describe, expect, it } from 'vitest';
import { buildSingleImagePdf, bytesToBase64 } from './pdfExport';

const DECODER = new TextDecoder('latin1');

function build(imageLength = 8) {
  const image = new Uint8Array(imageLength).fill(0xab);
  return buildSingleImagePdf({
    image,
    filter: 'DCTDecode',
    imageWidth: 120,
    imageHeight: 60,
    pageWidth: 640,
    pageHeight: 320
  });
}

describe('buildSingleImagePdf', () => {
  it('以 PDF 头开始、以 %%EOF 结束', () => {
    const text = DECODER.decode(build());
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('第二行是高位字节注释——少了它有些工具会把文件当文本处理', () => {
    const bytes = build();
    expect([...bytes.slice(9, 14)]).toEqual([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  });

  it('交叉引用表里的偏移真的指向对应的对象', () => {
    // 这是最容易写错、而且错了之后有的阅读器能打开有的打不开的地方
    const bytes = build();
    const text = DECODER.decode(bytes);
    const xrefAt = text.lastIndexOf('xref\n0 ');
    const entries = text
      .slice(text.indexOf('\n', xrefAt + 5) + 1)
      .split('\n')
      .slice(0, 6);

    for (let object = 1; object <= 5; object += 1) {
      const offset = Number(entries[object].slice(0, 10));
      expect(text.slice(offset, offset + `${object} 0 obj`.length)).toBe(`${object} 0 obj`);
    }
  });

  it('每条交叉引用记录正好 20 字节', () => {
    const text = DECODER.decode(build());
    const start = text.lastIndexOf('xref\n0 ');
    const body = text.slice(text.indexOf('\n', start + 5) + 1);
    for (let i = 0; i < 6; i += 1) {
      expect(body.slice(i * 20, (i + 1) * 20)).toHaveLength(20);
      expect(body.slice(i * 20, (i + 1) * 20).endsWith('\n')).toBe(true);
    }
  });

  it('startxref 指向 xref 关键字自己', () => {
    const text = DECODER.decode(build());
    const declared = Number(text.slice(text.lastIndexOf('startxref\n') + 10).split('\n')[0]);
    expect(text.slice(declared, declared + 4)).toBe('xref');
  });

  it('/Length 与真实的流长度一致', () => {
    // 写错的话阅读器会把图像读少或读多一截
    const text = DECODER.decode(build(1234));
    expect(text).toContain('/Length 1234');
  });

  it('图像字节原样嵌进去，没有被转义或截断', () => {
    const bytes = build(4);
    const text = DECODER.decode(bytes);
    const at = text.indexOf('stream\n', text.indexOf('/Subtype /Image')) + 'stream\n'.length;
    expect([...bytes.slice(at, at + 4)]).toEqual([0xab, 0xab, 0xab, 0xab]);
  });

  it('页面尺寸写进 MediaBox，内容流把图铺满整页', () => {
    const text = DECODER.decode(build());
    expect(text).toContain('/MediaBox [0 0 640 320]');
    expect(text).toContain('q 640 0 0 320 0 0 cm /Im0 Do Q');
  });

  it('Size 是对象数加一——0 号是那条固定的空闲记录', () => {
    const text = DECODER.decode(build());
    expect(text).toContain('/Size 6');
    expect(text).toContain('xref\n0 6\n');
  });
});

describe('bytesToBase64', () => {
  it('编码结果可以还原', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const decoded = atob(bytesToBase64(bytes));
    expect([...decoded].map(c => c.charCodeAt(0))).toEqual([...bytes]);
  });

  it('几十万字节也不爆栈', () => {
    // 一次性 String.fromCharCode(...array) 在这个量级就会 RangeError
    const bytes = new Uint8Array(300_000).fill(0x41);
    expect(() => bytesToBase64(bytes)).not.toThrow();
    expect(bytesToBase64(bytes).length).toBeGreaterThan(0);
  });
});
