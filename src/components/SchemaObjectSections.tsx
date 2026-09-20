import React, { useState } from 'react';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { describeError } from '../utils/describeError';
import clsx from 'clsx';
import { DatabaseType } from '../contracts/connection';
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
  /** 建表语句原文；null = 该方言没有权威来源（PostgreSQL） */
  ddl: string | null;
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

      <DdlSection ddl={objects.ddl} dbType={dbType} />
    </div>
  );
}

/**
 * 建表语句。给的是**数据库自己吐出来的原文**，不是我们从目录重建的。
 *
 * 所以 PostgreSQL 这里是空的：它没有 `SHOW CREATE TABLE`，而从目录重建要覆盖
 * 类型、默认值、identity、排序规则、存储参数、分区、继承、注释、触发器、RLS。
 * 少任何一项，产出的就是看起来权威、照着重建却不等价的 DDL——比没有更糟，
 * 因为没人会去核对它。上面的列 / 索引 / 外键 / 检查约束已经是权威的。
 */
function DdlSection({ ddl, dbType }: { ddl: string | null; dbType: ConnectionProfile['db_type'] }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = async () => {
    if (!ddl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(ddl);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      // 剪贴板可能被权限或非安全上下文拒绝；静默失败会让人以为复制成功了
      setCopyError(describeError(cause, '复制到剪贴板失败'));
    }
  };

  return (
    <section>
      <h3 className="flex items-center gap-2 bg-surface-sunken px-4 py-2 text-xs font-medium text-fg-muted">
        建表语句
        {ddl && (
          <button
            type="button"
            onClick={copy}
            className="ml-auto flex items-center gap-1 rounded-control border border-line-strong px-2 py-0.5 text-xs text-fg hover:bg-surface-hover"
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        )}
      </h3>

      {copyError && <p className="px-4 py-2 text-xs text-danger">{copyError}</p>}

      {ddl ? (
        <pre className="overflow-x-auto px-4 py-3 font-mono text-xs text-fg select-text whitespace-pre">
          {ddl}
        </pre>
      ) : (
        <p className="px-4 py-2 text-xs text-fg-subtle">
          {dbType === DatabaseType.PostgreSQL
            ? 'PostgreSQL 没有 SHOW CREATE TABLE，也不提供权威的建表语句。'
              + '从目录重建的 DDL 无法保证与原表等价，这里不生成——上面的列、索引、外键与检查约束是权威的。'
            : '数据库没有返回建表语句。'}
        </p>
      )}
    </section>
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
