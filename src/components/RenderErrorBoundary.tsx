import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';

interface RenderErrorBoundaryProps {
  children: ReactNode;
  /**
   * `tab`：包住一个标签的内容，出错时只换掉这一块，重试就是重新挂载它。
   * `app`：最外层兜底，出错时整窗只剩这一块，只能重新载入。
   */
  scope: 'tab' | 'app';
}

interface RenderErrorBoundaryState {
  error: Error | null;
}

/**
 * 渲染期抛出的异常会让 React 卸掉整棵树——没有这一层，窗口就是一片空白，
 * 连是哪里坏了都看不到，其余标签里没保存的东西也跟着没了。
 *
 * 错误原文印出来并且可选中：打包版没有开发者工具，这是用户能带回来的唯一线索。
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    // 类组件用不了 hook；出错之后也不需要跟着切语言重画
    const t = useLanguageStore.getState().t;
    const isApp = this.props.scope === 'app';
    return (
      <div role="alert" className="flex flex-1 items-start justify-center overflow-auto bg-surface p-8">
        <div className="w-full max-w-2xl space-y-3 rounded-panel border border-danger-line bg-danger-soft p-5">
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle size={18} className="shrink-0" />
            <h2 className="text-base font-medium">{t('crash.title')}</h2>
          </div>
          <p className="text-sm text-fg">{isApp ? t('crash.appDetail') : t('crash.detail')}</p>
          <pre className="max-h-48 select-text overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface px-3 py-2 font-mono text-xs text-fg">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => (isApp ? window.location.reload() : this.setState({ error: null }))}
            className="rounded-control border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {isApp ? t('crash.reload') : t('crash.retry')}
          </button>
        </div>
      </div>
    );
  }
}
