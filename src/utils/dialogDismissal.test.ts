import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 两条关闭路径要一致。
 *
 * 量过一次：15 个模态弹窗里有 3 个不响应 Escape。其中
 * `ConnectionForm` 点遮罩也不关——20 个字段的表单，必须按「取消」才走，
 * 这是**自洽**的选择，不动它。
 *
 * 另外两个（`CreateTableDialog`、`DdlPreviewDialog`）点遮罩会关、Esc 却不动，
 * 这是**自相矛盾**：点遮罩已经会把填的内容丢掉了，Esc 没有理由更保守。
 * 人学会了 Esc 能关弹窗，然后在这两个里它不动，会以为弹窗卡住了。
 *
 * 所以规则是：**点遮罩能关的，Esc 也要能关。** 反过来不要求——
 * 要显式取消的表单两条路都可以不给。
 */
const ROOT = fileURLToPath(new URL('../components', import.meta.url));

interface Dialog {
  readonly name: string;
  readonly dismissesOnScrim: boolean;
  readonly handlesEscape: boolean;
}

function dialogs(): Dialog[] {
  const found: Dialog[] = [];

  for (const entry of readdirSync(ROOT).filter((name) => name.endsWith('.tsx'))) {
    const source = readFileSync(join(ROOT, entry), 'utf8');
    const lines = source.split('\n');
    const scrim = lines.findIndex((line) => /fixed inset-0/.test(line) && /bg-scrim/.test(line));
    if (scrim < 0) {
      continue;
    }

    // 遮罩自己身上的 onClick 才算「点遮罩能关」：面板里的按钮不算，
    // 所以只看这个元素开标签那几行
    const element = lines.slice(Math.max(0, scrim - 3), scrim + 5).join('\n');
    found.push({
      name: entry.replace('.tsx', ''),
      dismissesOnScrim: /onClick=\{/.test(element),
      handlesEscape: /'Escape'|"Escape"/.test(source)
    });
  }

  return found;
}

describe('弹窗的两条关闭路径', () => {
  it('扫得到弹窗，否则这道门是空转的', () => {
    expect(dialogs().length).toBeGreaterThan(10);
  });

  it('点遮罩能关的，Esc 也要能关', () => {
    const offenders = dialogs()
      .filter((dialog) => dialog.dismissesOnScrim && !dialog.handlesEscape)
      .map((dialog) => dialog.name);

    expect(
      offenders,
      '点遮罩已经会丢掉内容，Esc 没有理由更保守——人会以为弹窗关不掉'
    ).toEqual([]);
  });
});
