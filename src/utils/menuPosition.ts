/** 菜单与视口边缘之间留的空隙 */
export const MENU_VIEWPORT_MARGIN = 4;

export interface MenuRect {
  width: number;
  height: number;
}

export interface MenuPosition {
  left: number;
  top: number;
}

function clampAxis(anchor: number, size: number, viewport: number): number {
  return Math.max(
    MENU_VIEWPORT_MARGIN,
    Math.min(anchor, viewport - size - MENU_VIEWPORT_MARGIN)
  );
}

/**
 * 把菜单夹进视口。
 *
 * 贴着右边或下边右击时菜单会有一半在屏幕外，而它是 `position: fixed`，
 * 滚也滚不到。
 *
 * 菜单比视口还大时以**上边**为准：溢出的那一半留在下面，至少第一项看得见。
 * 反过来会把整个菜单顶出屏幕，一项都点不到。两个 `Math` 的先后顺序就是
 * 这个取舍，不是随手写的。
 */
export function clampMenuPosition(
  anchor: { x: number; y: number },
  menu: MenuRect,
  viewport: MenuRect
): MenuPosition {
  return {
    left: clampAxis(anchor.x, menu.width, viewport.width),
    top: clampAxis(anchor.y, menu.height, viewport.height)
  };
}
