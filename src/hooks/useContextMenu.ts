import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampMenuPosition } from '../utils/menuPosition';

/**
 * 右键菜单的定位与关闭。
 *
 * 三个菜单（网格、标签、对象树）本来各抄了一份，而标签那份的边界是拿
 * `innerWidth - 180` 猜的——菜单实际多宽它并不知道。这里先渲染再量，
 * 量完才夹。
 *
 * 关闭挂在 `mousedown` 而不是 `click`：点到别处时，那一下点击本身应当
 * 照常落到它该去的地方，菜单只是顺手收起来，不该吃掉这次点击。
 */
export function useContextMenu<T extends HTMLElement>(
  anchor: { x: number; y: number },
  onDismiss: () => void
) {
  const ref = useRef<T>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const { x, y } = anchor;

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) {
      return;
    }
    const { width, height } = panel.getBoundingClientRect();
    setPosition(clampMenuPosition(
      { x, y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight }
    ));
  }, [x, y]);

  useEffect(() => {
    const dismissOutside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const dismiss = () => onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
      }
    };

    document.addEventListener('mousedown', dismissOutside);
    document.addEventListener('keydown', onKeyDown);
    // 滚动会让菜单留在原地而它指向的那一行跑掉，指的东西就不对了
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('mousedown', dismissOutside);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [onDismiss]);

  return { ref, style: { left: `${position.left}px`, top: `${position.top}px` } };
}
