import { describe, expect, it } from 'vitest';
import { MENU_VIEWPORT_MARGIN, clampMenuPosition } from './menuPosition';

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 120 };

describe('把右键菜单夹进视口', () => {
  it('位置够用时原样贴着鼠标', () => {
    expect(clampMenuPosition({ x: 300, y: 200 }, MENU, VIEWPORT)).toEqual({ left: 300, top: 200 });
  });

  it('贴着右边右击时往左收，不越过边界', () => {
    const { left } = clampMenuPosition({ x: 990, y: 200 }, MENU, VIEWPORT);
    expect(left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - MENU_VIEWPORT_MARGIN);
  });

  it('贴着下边右击时往上收', () => {
    const { top } = clampMenuPosition({ x: 300, y: 795 }, MENU, VIEWPORT);
    expect(top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - MENU_VIEWPORT_MARGIN);
  });

  it('贴着左上角时不会收到负数去', () => {
    expect(clampMenuPosition({ x: 0, y: 0 }, MENU, VIEWPORT))
      .toEqual({ left: MENU_VIEWPORT_MARGIN, top: MENU_VIEWPORT_MARGIN });
  });

  it('菜单比视口还高时以上边为准，溢出的留在下面', () => {
    // 反过来夹会把整个菜单顶出屏幕上方，一项都点不到
    const tall = { width: 200, height: 2000 };
    expect(clampMenuPosition({ x: 300, y: 400 }, tall, VIEWPORT).top).toBe(MENU_VIEWPORT_MARGIN);
  });

  it('菜单比视口还宽时同理，以左边为准', () => {
    const wide = { width: 2000, height: 120 };
    expect(clampMenuPosition({ x: 300, y: 200 }, wide, VIEWPORT).left).toBe(MENU_VIEWPORT_MARGIN);
  });
});
