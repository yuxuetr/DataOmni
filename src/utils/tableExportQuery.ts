import type { ColumnInfo } from '../contracts';
import type { ColumnFilter } from './tableFilters';
import { buildFilterClause } from './tableFilters';
import type { ColumnSort } from './resultSorting';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';
import { createSortedOrderClause, type TablePaginationOrder } from './tablePagination';

export interface TableExportQuery {
  schema: string | null | undefined;
  table: string;
  columns: readonly ColumnInfo[];
  /** 网格里当前显示的列，按显示顺序。隐藏的列不该在文件里冒出来。 */
  visibleColumns: readonly string[];
  filters: readonly ColumnFilter[];
  paginationOrder: TablePaginationOrder;
  sort: ColumnSort | null;
  dialect: SqlIdentifierDialect;
}

/**
 * 整表导出用的 SQL：和网格取数用的是同一条，只是去掉 LIMIT / OFFSET。
 *
 * 三件事都不能省：
 * - **投影收到可见列**。`SELECT *` 会把用户特地藏起来的列写进文件。
 * - **WHERE 照留**。筛选之后导出的应当是筛出来的那些行，不是整张表——
 *   少了它，文件比用户预期大几个数量级，而且没有任何地方提示过。
 * - **ORDER BY 照留**。不分页也需要一个确定的次序，否则同一张表导两次
 *   可能不一样，拿两份文件去 diff 会满屏都是差异。
 *
 * 一列都不可见时返回 null：`SELECT  FROM t` 不是 SQL，而调用方需要知道这件事
 * 才能把导出选项整个藏掉，而不是让用户点下去收到一条语法错误。
 */
export function buildTableExportQuery(request: TableExportQuery): string | null {
  const projection = request.visibleColumns
    .filter((name) => name.length > 0)
    .map((name) => quoteSqlIdentifier(name, request.dialect));
  if (projection.length === 0) {
    return null;
  }

  const tableReference = quoteQualifiedSqlIdentifier(
    request.schema ? [request.schema, request.table] : [request.table],
    request.dialect
  );
  const whereClause = buildFilterClause(request.filters, request.columns, request.dialect);
  const orderClause = createSortedOrderClause(request.paginationOrder, request.sort, request.dialect);

  return [`SELECT ${projection.join(', ')}`, `FROM ${tableReference}`, whereClause, orderClause]
    .filter((part) => part.trim().length > 0)
    .join(' ');
}
