/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import { useLanguageStore } from '../stores/languageStore';

let container: HTMLDivElement;
let root: Root;
let shouldThrow = true;

function Fragile() {
  if (shouldThrow) {
    // 这次白屏的真实形状：点击事件被当成条件数组存了进去
    throw new TypeError('appliedFilters.filter is not a function');
  }
  return <p>drawn</p>;
}

beforeEach(() => {
  // React 会把捕获到的错误再打一遍到 console.error，这里不需要看
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  shouldThrow = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('RenderErrorBoundary', () => {
  it('shows the error instead of unmounting everything', () => {
    act(() => {
      root.render(<RenderErrorBoundary scope="tab"><Fragile /></RenderErrorBoundary>);
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('appliedFilters.filter is not a function');
    expect(container.textContent).toContain('Try again');
  });

  it('try again remounts the children once they stop throwing', () => {
    act(() => {
      root.render(<RenderErrorBoundary scope="tab"><Fragile /></RenderErrorBoundary>);
    });
    shouldThrow = false;
    const retry = container.querySelector('button');
    act(() => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toBe('drawn');
  });

  it('offers a reload at the app level, where there is nothing left to retry', () => {
    act(() => {
      root.render(<RenderErrorBoundary scope="app"><Fragile /></RenderErrorBoundary>);
    });
    expect(container.textContent).toContain('Reload');
    expect(container.textContent).not.toContain('Try again');
  });
});
