import React from 'react';
import { AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import type { ConnectionProfile } from '../contracts';
import type {
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo
} from '../utils/schemaObjects';

export interface SchemaObjects {
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** null = 该方言没有检查约束目录，不是「没有检查约束」 */
  checkConstraints: CheckConstraintInfo[] | null;
  error?: string;
}

/**
 * 索引 / 外键 / 检查约束三块。
 *
 * 和列一样是只读展示，但信息密度要求不同：一条索引的关键是「哪几列、什么
 * 顺序、是否唯一」，写成一行 `(a, b)` 比再摊成一张五列表格更快读懂。
 */
export function SchemaObjectSections({
  objects,
  dbType
}: {
  objects: SchemaObjects | null;
  dbType: ConnectionProfile['db_type'];
}) {
  if (!objects) {
    return (
      <p className="px-4 py-3 text-xs text-fg-subtle">正在读取索引与约束…</p>
    );
  }

  // 读失败时只报错。继续画「索引 0 / 没有索引」是在陈述一个根本没查成的事实，
  // 而「没有索引」和「没查到」对用户的意义完全相反。
  if (objects.error) {
    return (
      <p className="flex items-start gap-2 border-t border-line bg-danger-soft px-4 py-2 text-xs text-danger">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{objects.error}</span>
      </p>
    );
  }

  return (
    <div className="divide-y divide-line border-t border-line">
      <SchemaSection title="索引" count={objects.indexes.length} emptyText="没有索引">
        {objects.indexes.map(index => (
          <li key={index.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2">
            <span className="font-mono text-xs text-fg">{index.name}</span>
            <span className="font-mono text-xs text-fg-muted">
              ({index.columns.join(', ')})
            </span>
            {index.isPrimary && <Pill tone="accent">主键</Pill>}
            {index.isUnique && !index.isPrimary && <Pill tone="accent">唯一</Pill>}
            {index.method && <span className="text-xs text-fg-subtle">{index.method}</span>}
          </li>
        ))}
      </SchemaSection>

      <SchemaSection title="外键" count={objects.foreignKeys.length} emptyText="没有外键">
        {objects.foreignKeys.map(foreignKey => (
          <li key={foreignKey.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2">
            <span className="font-mono text-xs text-fg">{foreignKey.name}</span>
            <span className="font-mono text-xs text-fg-muted">
              ({foreignKey.columns.join(', ')}) →{' '}
              {foreignKey.referencedSchema ? `${foreignKey.referencedSchema}.` : ''}
              {foreignKey.referencedTable}
              {/* SQLite 允许省略被引用列，默认指向父表主键；不伪造一个列名 */}
              {foreignKey.referencedColumns.every(column => column === null)
                ? ' (主键)'
                : ` (${foreignKey.referencedColumns.map(column => column ?? '?').join(', ')})`}
            </span>
            {foreignKey.onDelete && foreignKey.onDelete !== 'NO ACTION' && (
              <span className="text-xs text-fg-subtle">删除时 {foreignKey.onDelete}</span>
            )}
            {foreignKey.onUpdate && foreignKey.onUpdate !== 'NO ACTION' && (
              <span className="text-xs text-fg-subtle">更新时 {foreignKey.onUpdate}</span>
            )}
          </li>
        ))}
      </SchemaSection>

      {objects.checkConstraints === null ? (
        <SchemaSection title="检查约束" count={null} emptyText="">
          <li className="px-4 py-2 text-xs text-fg-subtle">
            {dbType === 'sqlite'
              ? 'SQLite 不提供检查约束目录，只能从建表语句原文里看'
              : '当前数据库类型不提供检查约束目录'}
          </li>
        </SchemaSection>
      ) : (
        <SchemaSection
          title="检查约束"
          count={objects.checkConstraints.length}
          emptyText="没有检查约束"
        >
          {objects.checkConstraints.map(constraint => (
            <li key={constraint.name} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2">
              <span className="font-mono text-xs text-fg">{constraint.name}</span>
              <span className="font-mono text-xs text-fg-muted break-all">
                {constraint.expression}
              </span>
            </li>
          ))}
        </SchemaSection>
      )}
    </div>
  );
}

function SchemaSection({
  title,
  count,
  emptyText,
  children
}: {
  title: string;
  count: number | null;
  emptyText: string;
  children: React.ReactNode;
}) {
  const isEmpty = count === 0;

  return (
    <section>
      <h3 className="flex items-baseline gap-2 bg-surface-sunken px-4 py-2 text-xs font-medium text-fg-muted">
        {title}
        {count !== null && <span className="text-fg-subtle">{count}</span>}
      </h3>
      {isEmpty ? (
        <p className="px-4 py-2 text-xs text-fg-subtle">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line">{children}</ul>
      )}
    </section>
  );
}

function Pill({ tone, children }: { tone: 'accent'; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        'rounded-control px-1.5 py-0.5 text-xs font-medium',
        tone === 'accent' && 'bg-accent-soft text-accent'
      )}
    >
      {children}
    </span>
  );
}
