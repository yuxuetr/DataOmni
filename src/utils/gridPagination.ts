/**
 * 网格分页档位。
 *
 * 两个表格此前给的档位不一样（10/25/50/100 与 25/50/100/200），统一成一份。
 *
 * 这个上限同时是「暂不做行虚拟化」这个决定的依据。实测最坏情况——100 行 × 20 列
 * 共 2000 个单元格——整次重渲染中位数 25ms，且这个数还包含两帧 requestAnimationFrame
 * 的等待，真正的渲染工作远在一帧之内。分页已经把 DOM 规模钉死了，虚拟化解决的是
 * 分页已经解决的问题。
 *
 * 重估条件是可执行的：`gridPagination.test.ts` 断言所有档位都不超过
 * MAX_UNVIRTUALIZED_ROWS。谁要加一个 1000 行的档位，或者改成无限滚动不再分页，
 * 那条测试就会红，逼着重新测一遍再决定。
 */
export const GRID_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

export const MAX_UNVIRTUALIZED_ROWS = 200;
