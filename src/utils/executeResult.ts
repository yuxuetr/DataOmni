export interface ExecuteResult {
  rowsAffected: number;
}

export const assertSingleRowAffected = (
  result: ExecuteResult,
  operation: '更新' | '删除'
): void => {
  if (result.rowsAffected === 1) {
    return;
  }

  if (result.rowsAffected === 0) {
    throw new Error(`${operation}失败：目标记录不存在或已被其他操作修改`);
  }

  throw new Error(`${operation}失败：预期影响 1 行，实际影响 ${result.rowsAffected} 行`);
};
