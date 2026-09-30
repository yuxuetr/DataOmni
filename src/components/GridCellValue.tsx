import clsx from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import type { SerializedResultValue } from '../contracts/resultSet';
import { describeCellDisplay } from '../utils/cellDisplay';
import { formatResultValue } from '../utils/resultValues';
import { describeBoundValue, describeCellInput } from '../utils/cellInput';
import { pendingCellInput, type PendingDelete, type PendingUpdate } from '../utils/pendingChanges';

/**
 * 网格里一个单元格的值。
 *
 * 之所以抽出来而不是在两张表里各写一遍：SQL 结果表和表数据视图都要按同一套
 * 约定区分 NULL / 空字符串 / 空白 / 二进制，两边分头写必然会漂移成两套约定，
 * 而这恰恰是用户最需要能靠直觉认出来的一处。
 */
export function GridCellValue({
  value,
  note
}: {
  value: SerializedResultValue;
  /** 接在悬停提示后面另起一行，比如待提交格子的原值 */
  note?: string;
}) {
  const t = useLanguageStore((state) => state.t);
  const display = describeCellDisplay(value);
  const withNote = (title: string) => (note ? `${title}\n${note}` : title);

  if (display.kind === 'value') {
    return (
      <span className="block truncate" title={withNote(formatResultValue(value))}>
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
      title={withNote(title)}
    >
      {display.text}
    </span>
  );
}

/**
 * 这一行排着改动时的格子：改了的列画新值，悬停另起一行写原值；没改的列与待删的行照旧。
 *
 * 两张网格都要：排了队的行只给撤销、不能再编辑，格子里要是还画着加载时的值，
 * 用户按下回车后就再也看不到自己改成了什么——只有打开预览才对得上。
 */
export function StagedCellValue({
  value,
  pending,
  column
}: {
  value: SerializedResultValue;
  pending: PendingUpdate | PendingDelete | undefined;
  column: string;
}) {
  const t = useLanguageStore((state) => state.t);
  const staged = pendingCellInput(pending, column);
  if (staged === undefined || !pending) {
    return <GridCellValue value={value} />;
  }
  const note = t('changes.cellWas', { value: describeBoundValue(pending.original[column] ?? null) });
  if (staged.kind === 'value' || staged.kind === 'null') {
    return <GridCellValue value={staged.kind === 'null' ? null : staged.value} note={note} />;
  }
  // DEFAULT 与表达式的结果由数据库算，这里只能照写
  return (
    <span className="block truncate italic text-fg-muted" title={note}>
      {describeCellInput(staged)}
    </span>
  );
}
