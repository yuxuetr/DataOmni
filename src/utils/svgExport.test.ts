/**
 * 需要 DOM：要拿真实的计算样式。
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  dataUrlToBase64,
  readCssColor,
  serializeSvgWithInlineStyles,
  svgToDataUrl
} from './svgExport';

function buildSvg(): SVGSVGElement {
  document.body.innerHTML = `
    <style>.box { fill: rgb(1, 2, 3); stroke: rgb(4, 5, 6); }</style>
    <svg id="s" style="transform: translate(20px, 30px)">
      <rect class="box" x="0" y="0" width="10" height="10"></rect>
      <text class="box" x="1" y="2">orders</text>
    </svg>`;
  return document.getElementById('s') as unknown as SVGSVGElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('serializeSvgWithInlineStyles', () => {
  it('把类名上的颜色写成行内属性——导出的文件要自己带着样式', () => {
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#ffffff',
      width: 100,
      height: 50
    });
    expect(out).toContain('fill="rgb(1, 2, 3)"');
    expect(out).toContain('stroke="rgb(4, 5, 6)"');
  });

  it('去掉类名——在导出的文件里没有意义，留着只会让文件变大', () => {
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#ffffff',
      width: 100,
      height: 50
    });
    expect(out).not.toContain('class="box"');
  });

  it('画背景矩形——SVG 默认透明，深色主题的文字放进白底文档会看不见', () => {
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#101418',
      width: 100,
      height: 50
    });
    expect(out).toContain('fill="#101418"');
    expect(out.indexOf('<rect width="100%"')).toBeLessThan(out.indexOf('orders'));
  });

  it('用传入的尺寸，并丢掉屏幕上的平移', () => {
    // 平移是视图状态，导出的图带着它会莫名其妙偏一块
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#ffffff',
      width: 640,
      height: 480
    });
    expect(out).toContain('width="640"');
    expect(out).toContain('viewBox="0 0 640 480"');
    expect(out).not.toContain('translate(20px');
  });

  it('带 xmlns，否则浏览器不认这是 SVG', () => {
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#ffffff',
      width: 10,
      height: 10
    });
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('内容原样保留', () => {
    const out = serializeSvgWithInlineStyles(buildSvg(), {
      background: '#ffffff',
      width: 10,
      height: 10
    });
    expect(out).toContain('orders');
  });
});

describe('readCssColor', () => {
  it('读不到变量时用回退值', () => {
    expect(readCssColor('--nope-not-here', '#abcdef')).toBe('#abcdef');
  });
});

describe('svgToDataUrl', () => {
  it('中文表名不会让它抛错', () => {
    // btoa 只吃 Latin-1，图里有一个中文表名就会抛 InvalidCharacterError
    const url = svgToDataUrl('<svg><text>用户表</text></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1])).toContain('用户表');
  });

  it('尖括号被转义，不会提前截断 URL', () => {
    expect(svgToDataUrl('<svg/>')).not.toContain('<');
  });
});

describe('dataUrlToBase64', () => {
  it('去掉前缀只留正文', () => {
    expect(dataUrlToBase64('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=');
  });

  it('不是 data URL 时返回空串，不把整串当成 base64 发出去', () => {
    expect(dataUrlToBase64('nonsense')).toBe('');
  });
});
