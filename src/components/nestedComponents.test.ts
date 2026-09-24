import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 组件体里不许再声明组件。
 *
 * 在函数体里写 `const Cell = (...) => <td/>`，再用 `<Cell />`，每次渲染都是一个
 * 新的组件类型：React 把它连同子树卸掉重挂，输入框丢焦点、本地状态清零、
 * autoFocus 重新触发。表格编辑行就这样坏过——每敲一个字，焦点跳到这一行
 * 最后一个输入框（TableDataViewer 的 EditableCell，从第一版起就是这样）。
 *
 * 判据只看形状：缩进过的 `const 大写开头 = (` 或 `function 大写开头(`，且同一个
 * 文件里以 `<名字` 用到它。顶层声明（第 0 列）不算。
 */
const COMPONENT_DIRS = ['src/components', 'src'];

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of COMPONENT_DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
        files.push(join(dir, name));
      }
    }
  }
  return files;
}

export function nestedComponents(source: string): string[] {
  const declared = [...source.matchAll(/^[ \t]+(?:const ([A-Z]\w*) = (?:\(|async \()|function ([A-Z]\w*)\()/gm)]
    .map((match) => match[1] ?? match[2]);
  return declared.filter((name) => new RegExp(`<${name}[\\s/>]`).test(source));
}

describe('组件体里不声明组件', () => {
  it('判据能认出嵌套声明，也放过顶层声明和普通函数', () => {
    const nested = 'export function Grid() {\n  const Cell = ({ v }) => <td>{v}</td>;\n  return <Cell v={1} />;\n}\n';
    const topLevel = 'const Cell = ({ v }) => <td>{v}</td>;\nexport function Grid() {\n  return <Cell v={1} />;\n}\n';
    const renderFunction = 'export function Grid() {\n  const renderCell = (v) => <td>{v}</td>;\n  return renderCell(1);\n}\n';
    expect(nestedComponents(nested)).toEqual(['Cell']);
    expect(nestedComponents(topLevel)).toEqual([]);
    expect(nestedComponents(renderFunction)).toEqual([]);
  });

  it('src 下没有一处', () => {
    const offenders = sourceFiles().flatMap((file) =>
      nestedComponents(readFileSync(file, 'utf8')).map((name) => `${file}: ${name}`)
    );
    expect(offenders).toEqual([]);
  });
});
