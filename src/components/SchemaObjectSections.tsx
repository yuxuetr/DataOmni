import React, { useState } from 'react';
import { useLanguageStore } from '../stores/languageStore';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { describeError } from '../utils/describeError';
import clsx from 'clsx';
import { DatabaseType } from '../contracts/connection';
import type { ConnectionProfile } from '../contracts';
import type { SchemaObjects } from '../utils/schemaObjects';

export type { SchemaObjects };

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
  const t = useLanguageStore((state) => state.t);
  if (!objects) {
    return (
      <p className="px-4 py-3 text-xs text-fg-subtle">{t('schema.loadingObjects')}</p>
    );
  }

  // 读失败的段只报错，别的段照常画。继续画「索引 0 / 没有索引」是在陈述一个
  // 根本没查成的事实，而「没有索引」和「没查到」对用户的意义完全相反。
  const { failures } = objects;

  return (
    <div className="divide-y divide-line border-t border-line">
      <SchemaSection
        title={t('schema.indexes')}
        count={objects.indexes.length}
        emptyText={t('schema.indexes.empty')}
        failure={failures.indexes}
      >
        {objects.indexes.map(index => (
          <li key={index.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2">
            <span className="font-mono text-xs text-fg">{index.name}</span>
            <span className="font-mono text-xs text-fg-muted">
              ({index.columns.join(', ')})
            </span>
            {index.isPrimary && <Pill tone="accent">{t('schema.primaryKey')}</Pill>}
            {index.isUnique && !index.isPrimary && <Pill tone="accent">{t('schema.unique')}</Pill>}
            {index.method && <span className="text-xs text-fg-subtle">{index.method}</span>}
          </li>
        ))}
      </SchemaSection>

      <SchemaSection
        title={t('schema.foreignKeys')}
        count={objects.foreignKeys.length}
        emptyText={t('schema.foreignKeys.empty')}
        failure={failures.foreignKeys}
      >
        {objects.foreignKeys.map(foreignKey => (
          <li key={foreignKey.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2">
            <span className="font-mono text-xs text-fg">{foreignKey.name}</span>
            <span className="font-mono text-xs text-fg-muted">
              ({foreignKey.columns.join(', ')}) →{' '}
              {foreignKey.referencedSchema ? `${foreignKey.referencedSchema}.` : ''}
              {foreignKey.referencedTable}
              {/* SQLite 允许省略被引用列，默认指向父表主键；不伪造一个列名 */}
              {foreignKey.referencedColumns.every(column => column === null)
                ? ` (${t('schema.referencesPrimaryKey')})`
                : ` (${foreignKey.referencedColumns.map(column => column ?? '?').join(', ')})`}
            </span>
            {foreignKey.onDelete && foreignKey.onDelete !== 'NO ACTION' && (
              <span className="text-xs text-fg-subtle">
                {t('schema.onDelete', { action: foreignKey.onDelete })}
              </span>
            )}
            {foreignKey.onUpdate && foreignKey.onUpdate !== 'NO ACTION' && (
              <span className="text-xs text-fg-subtle">
                {t('schema.onUpdate', { action: foreignKey.onUpdate })}
              </span>
            )}
          </li>
        ))}
      </SchemaSection>

      {failures.checkConstraints ? (
        <SchemaSection
          title={t('schema.checks')}
          count={null}
          emptyText=""
          failure={failures.checkConstraints}
        >
          {null}
        </SchemaSection>
      ) : objects.checkConstraints === null ? (
        <SchemaSection title={t('schema.checks')} count={null} emptyText="">
          <li className="px-4 py-2 text-xs text-fg-subtle">
            {dbType === 'sqlite'
              ? t('schema.checks.noCatalogSqlite')
              : t('schema.checks.noCatalog')}
          </li>
        </SchemaSection>
      ) : (
        <SchemaSection
          title={t('schema.checks')}
          count={objects.checkConstraints.length}
          emptyText={t('schema.checks.empty')}
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

      <SchemaSection
        title={t('schema.triggers')}
        count={objects.triggers.length}
        emptyText={t('schema.triggers.empty')}
        failure={failures.triggers}
      >
        {objects.triggers.map(trigger => (
          <li key={trigger.name} className="px-4 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-fg">{trigger.name}</span>
              {/* MySQL 把时机与事件拆开给，其它方言含在下面的定义原文里 */}
              {trigger.timing && trigger.event && (
                <Pill tone="accent">{trigger.timing} {trigger.event}</Pill>
              )}
            </div>
            <pre className="mt-1 overflow-x-auto font-mono text-xs text-fg-muted select-text whitespace-pre">
              {trigger.definition}
            </pre>
          </li>
        ))}
      </SchemaSection>

      <DdlSection ddl={objects.ddl} dbType={dbType} failure={failures.ddl} />
    </div>
  );
}

/**
 * 对象定义原文。给的是**数据库自己吐出来的**，不是我们从目录重建的。
 *
 * PostgreSQL 对**视图**有（`pg_get_viewdef`），对**表**没有：它没有
 * `SHOW CREATE TABLE`，而从目录重建要覆盖类型、默认值、identity、排序规则、
 * 存储参数、分区、继承、注释、触发器、RLS。少任何一项，产出的就是看起来权威、
 * 照着重建却不等价的 DDL——比没有更糟，因为没人会去核对它。
 */
function DdlSection({
  ddl,
  dbType,
  failure
}: {
  ddl: string | null;
  dbType: ConnectionProfile['db_type'];
  failure: string | undefined;
}) {
  const t = useLanguageStore((state) => state.t);
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
      setCopyError(describeError(cause, t('common.copyFailed')));
    }
  };

  return (
    <section>
      <h3 className="flex items-center gap-2 bg-surface-sunken px-4 py-2 text-xs font-medium text-fg-muted">
        {t('schema.definition')}
        {ddl && (
          <button
            type="button"
            onClick={copy}
            className="ml-auto flex items-center gap-1 rounded-control border border-line-strong px-2 py-0.5 text-xs text-fg hover:bg-surface-hover"
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        )}
      </h3>

      {copyError && <p className="px-4 py-2 text-xs text-danger">{copyError}</p>}

      {failure ? (
        <SectionFailure message={failure} />
      ) : ddl ? (
        <pre className="overflow-x-auto px-4 py-3 font-mono text-xs text-fg select-text whitespace-pre">
          {ddl}
        </pre>
      ) : (
        <p className="px-4 py-2 text-xs text-fg-subtle">
          {dbType === DatabaseType.PostgreSQL || dbType === DatabaseType.SqlServer
            ? t('schema.definition.noCreateTable', {
              database: dbType === DatabaseType.PostgreSQL ? 'PostgreSQL' : 'SQL Server'
            })
            : t('schema.definition.empty')}
        </p>
      )}
    </section>
  );
}

function SchemaSection({
  title,
  count,
  emptyText,
  failure,
  children
}: {
  title: string;
  count: number | null;
  emptyText: string;
  /** 这一段没查成。有它就不画数量，更不画「没有」 */
  failure?: string;
  children: React.ReactNode;
}) {
  const isEmpty = count === 0;

  return (
    <section>
      <h3 className="flex items-baseline gap-2 bg-surface-sunken px-4 py-2 text-xs font-medium text-fg-muted">
        {title}
        {count !== null && !failure && <span className="text-fg-subtle">{count}</span>}
      </h3>
      {failure ? (
        <SectionFailure message={failure} />
      ) : isEmpty ? (
        <p className="px-4 py-2 text-xs text-fg-subtle">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line">{children}</ul>
      )}
    </section>
  );
}

function SectionFailure({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 bg-danger-soft px-4 py-2 text-xs text-danger">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
    </p>
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
