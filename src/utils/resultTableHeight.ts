/**
 * 结果表该有多高。
 *
 * 此前是写死的 `maxHeight: 600px`，和可用空间没有关系。实测 1440×1400 视口、
 * 一条语句：结果区 1000px、表格可视 600px、内容 750px——**250px 空着而表格
 * 在滚**。而一条语句是最常见的情形。
 *
 * 直接改成「占满可用空间」不行，试过并回退了：短窗口上可用空间只剩 80px，
 * 表格被压到两行，比滚一下糟得多。
 *
 * 所以规则是三段，而且**每一段都不比写死 600 更差**：
 *
 * - 内容装得下 → 按内容。三行就是三行，不撑一个 600px 的空盒子。
 * - 装不下但有地方 → 用满可用空间。这一段是净赚的：原来只给 600。
 * - 装不下且地方也不够 → 停在 `fallback`（就是原来那个 600），让外层结果区
 *   自己滚。继续压下去表格只剩两行，而滚一下是人本来就会的动作。
 *
 * 还没量到可用空间时（首帧、`available <= 0`）落到第三段，得到的正是今天的
 * 行为——所以这个改动没有「首帧闪一下」的窗口。
 */
export const FALLBACK_RESULT_TABLE_HEIGHT = 600;

export function resultTableHeight(
  available: number,
  content: number,
  fallback: number = FALLBACK_RESULT_TABLE_HEIGHT
): number {
  if (content <= available) {
    return content;
  }
  // `min(content, fallback)`：内容本来就比 fallback 矮时不要撑出空白
  return Math.max(available, Math.min(content, fallback));
}
