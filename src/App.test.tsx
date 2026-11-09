/**
 * @vitest-environment happy-dom
 */
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 根组件一起来就会问后端几件事（连接列表、AI 是否编进来……）：列表给空，开关给关
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'ai_available' ? false : [])),
  Channel: class {}
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {})
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    destroy: async () => {}
  })
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  confirm: vi.fn(async () => false),
  message: vi.fn(async () => {})
}));

const { default: App } = await import('./App');
const { useQueryStore } = await import('./stores/queryStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('App', () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  // 驱动量的门（AGENTS.md「性能指标定成驱动量的上限」）：草稿每个键变一次，
  // 根组件不能跟着重渲染——原来整份订阅 documents，每个键都把整棵树重画一遍
  it('草稿变化不让根组件重渲染', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const commits: string[] = [];

    await act(async () => {
      root.render(
        <Profiler id="app" onRender={(id) => commits.push(id)}>
          <App />
        </Profiler>
      );
    });
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
    // 等启动时发出去的后端请求都回来、各自 setState 完，再开始数
    for (let settle = 0; settle < 5; settle += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // 第一个键让这份草稿从「空」变「未保存」，标签上要出现圆点，这一次重渲染是该有的
    await act(async () => {
      useQueryStore.getState().restoreDocuments({ 'sql-x': 'S' });
    });

    commits.length = 0;
    // 每个键单独一次 act：不让 React 把几次改动合成一次提交，数到的就是真实的每键次数
    for (const text of ['SE', 'SEL', 'SELE', 'SELEC']) {
      await act(async () => {
        useQueryStore.getState().restoreDocuments({ 'sql-x': text });
      });
    }
    expect(commits).toEqual([]);

    await act(async () => root.unmount());
  });
});
