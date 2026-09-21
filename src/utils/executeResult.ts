import { translateNow } from '../stores/languageStore';

export interface ExecuteResult {
  rowsAffected: number;
}

/**
 * `operation` 是已经本地化好的动词（「更新」/「delete」），由调用方给出。
 *
 * 这里用 `translateNow` 而不是接一个 `t`：这个函数在 React 之外被调用，
 * 而抛出的错误是**立刻**拿去显示的，取当下的语言就是对的。
 */
export const assertSingleRowAffected = (result: ExecuteResult, operation: string): void => {
  if (result.rowsAffected === 1) {
    return;
  }

  if (result.rowsAffected === 0) {
    throw new Error(translateNow('execute.noRowAffected', { operation }));
  }

  throw new Error(
    translateNow('execute.tooManyRowsAffected', { operation, count: result.rowsAffected })
  );
};
