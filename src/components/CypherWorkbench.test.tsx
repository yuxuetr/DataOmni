/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import type { CypherNodeValue } from '../utils/cypherValue';
import { MAX_UNVIRTUALIZED_ROWS } from '../utils/gridPagination';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { CypherWorkbench } = await import('./CypherWorkbench');

let container: HTMLDivElement;
let root: Root;

const connection: ConnectionProfile = {
  id: 'neo',
  name: 'neo',
  db_type: DatabaseType.Neo4j,
  host: '127.0.0.1',
  port: 7687,
  username: 'neo4j',
  password: '',
  ssl: false,
  save_password: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

const alice = (age: string): CypherNodeValue => ({
  kind: 'node',
  elementId: '4:db:1',
  labels: ['Person'],
  properties: [['age', { kind: 'integer', value: age }], ['name', { kind: 'string', value: 'Alice' }]]
});

const result = (rows: CypherNodeValue[][]) => ({
  columns: ['n'],
  rows,
  truncated: false,
  summary: { queryType: 'r', database: 'neo4j', counters: [], notifications: [], plan: null }
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`没有「${label}」按钮`);
  return found;
}

function valueInput(key: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="Value of ${key}"]`);
  if (!found) throw new Error(`没有 ${key} 的值输入框`);
  return found;
}

/** 受控输入框要走原生 setter，React 才认这次改动 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

/** 查出 age 为 30 的 Alice，点开它，把 age 改成 31 */
async function openAndEdit() {
  await act(async () => {
    root.render(<CypherWorkbench connection={connection} />);
  });
  await click(button('Run all'));
  await click(button('Table'));
  const cell = [...container.querySelectorAll('td')].find((candidate) => candidate.textContent?.includes('Alice'));
  if (!cell) throw new Error('结果里没有 Alice');
  await click(cell.querySelector('button') ?? cell);
  await act(async () => {
    typeInto(valueInput('age'), '31');
  });
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  useQueryStore.setState({ connectionString: 'bolt://127.0.0.1:7687' });
  useQueryStore.getState().openDocument('cypher-test');
  useQueryStore.getState().setSqlInput('MATCH (n:Person) RETURN n');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CypherWorkbench 改节点', () => {
  // 打包版回归时撞上的：打开之后别处把 age 改成了 99，这边改成 31 一保存，99 悄无声息地没了
  it('别处改过要动的属性：什么也没写，说清楚是被改了而不是被删了，草稿留着，还原显示现在的值', async () => {
    const writes: string[] = [];
    invoke.mockImplementation(async (command: string, args: { query: string }) => {
      if (command === 'neo4j_query_type') return 'r';
      if (command !== 'neo4j_run') throw new Error(`没料到的命令 ${command}`);
      if (args.query.startsWith('MATCH (n:Person)')) return result([[alice('30')]]);
      if (args.query.includes('SET')) {
        writes.push(args.query);
        // 比对条件不成立：一行也不匹配
        return result(args.query.includes('n.age = 30') ? [] : [[alice('31')]]);
      }
      return result([[alice('99')]]);
    });
    await openAndEdit();
    await click(button('Save'));

    expect(writes).toHaveLength(1);
    expect(container.textContent).toContain('changed elsewhere after you opened it');
    expect(container.textContent).not.toContain('it may have been deleted');
    expect(valueInput('age').value).toBe('31');

    await click(button('Revert'));
    expect(valueInput('age').value).toBe('99');
    expect(container.textContent).not.toContain('changed elsewhere after you opened it');
  });

  it('再读也读不到：是被删了', async () => {
    invoke.mockImplementation(async (command: string, args: { query: string }) => {
      if (command === 'neo4j_query_type') return 'r';
      if (args.query.startsWith('MATCH (n:Person)')) return result([[alice('30')]]);
      return result([]);
    });
    await openAndEdit();
    await click(button('Save'));

    expect(container.textContent).toContain('it may have been deleted');
  });
});

describe('CypherWorkbench 删节点', () => {
  it('数完之后别处又连上了关系：什么也没删，说清楚是关系变了', async () => {
    let deleted = 0;
    invoke.mockImplementation(async (command: string, args: { query: string }) => {
      if (command === 'neo4j_query_type') return 'r';
      if (args.query.startsWith('MATCH (n:Person)')) return result([[alice('30')]]);
      if (args.query.includes('RETURN COUNT')) {
        return { ...result([]), columns: ['relationships'], rows: [[{ kind: 'integer', value: '3' }]] };
      }
      if (args.query.includes('DELETE')) {
        // 服务端那边已经是 4 条了：条数对不上的删除一行也不匹配
        if (args.query.includes('= 3')) return result([]);
        deleted += 1;
        return { ...result([]), summary: { ...result([]).summary, counters: [['nodesDeleted', 1]] } };
      }
      return result([[alice('30')]]);
    });
    await openAndEdit();
    await click(button('Delete node'));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Run anyway');
    if (!confirm) throw new Error('没有确认框');
    await click(confirm);

    expect(deleted).toBe(0);
    expect(container.textContent).toContain('nothing was deleted');
    expect(container.textContent).not.toContain('it may have been deleted');
  });
});

describe('CypherWorkbench 结果表', () => {
  it('一页不超过 MAX_UNVIRTUALIZED_ROWS 行，翻页看后面的', async () => {
    // 打包版回归时量的：行数上限选 10,000 时 5 万个单元格一次画完，结果晚几秒才出来。
    // 网格那边早就定了「分页把 DOM 规模钉死」，这张表漏掉了
    const numbers = Array.from({ length: 450 }, (_, index) => [{ kind: 'integer', value: String(index + 1) }]);
    invoke.mockImplementation(async (command: string) => {
      if (command === 'neo4j_query_type') return 'r';
      return { ...result([]), columns: ['x'], rows: numbers };
    });
    await act(async () => {
      root.render(<CypherWorkbench connection={connection} />);
    });
    await click(button('Run all'));
    const cells = () => [...container.querySelectorAll('td')].map((cell) => cell.textContent);

    expect(cells()).toHaveLength(MAX_UNVIRTUALIZED_ROWS);
    expect(container.textContent).toContain('450 rows');
    expect(container.textContent).toContain('Page 1 of 3');

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]') ?? button('missing'));
    expect(cells()[0]).toBe('201');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]') ?? button('missing'));
    expect(cells()).toHaveLength(50);
    expect(cells()[49]).toBe('450');
  });
});
