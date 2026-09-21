import clsx from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import type { SerializedResultValue } from '../contracts/resultSet';
import { describeCellDisplay } from '../utils/cellDisplay';
import { formatResultValue } from '../utils/resultValues';

/**
 * 网格里一个单元格的值。
 *
 * 之所以抽出来而不是在两张表里各写一遍：SQL 结果表和表数据视图都要按同一套
 * 约定区分 NULL / 空字符串 / 空白 / 二进制，两边分头写必然会漂移成两套约定，
 * 而这恰恰是用户最需要能靠直觉认出来的一处。
 */
export function GridCellValue({ value }: { value: SerializedResultValue }) {
  const t = useLanguageStore((state) => state.t);
  const display = describeCellDisplay(value);

  if (display.kind === 'value') {
    return (
      <span className="block truncate" title={formatResultValue(value)}>
        {display.text}
      </span>
    );
  }

  const title = display.kind === 'null'
    ? t('cell.null')
    : display.kind === 'empty'
      ? t('cell.empty')
      : display.kind === 'blank'
        ? t('cell.blank', { count: typeof value === 'string' ? value.length : 0 })
        : t('cell.binary', { count: display.byteLength ?? 0 });

  return (
    <span
      className={clsx(
        'block truncate',
        // 空值三兄弟用同一套弱化样式：它们共同的意思是「这里没有可读内容」，
        // 而字面上写着 NULL 的那个**字符串**走的是上面的常规样式
        display.kind === 'binary' ? 'text-fg-muted' : 'italic text-fg-subtle'
      )}
      title={title}
    >
      {display.text}
    </span>
  );
}
