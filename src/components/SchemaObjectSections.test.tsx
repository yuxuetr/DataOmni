/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { zh } from '../i18n/zh';
import { useLanguageStore } from '../stores/languageStore';
import type { SchemaObjects } from '../utils/schemaObjects';
import { SchemaObjectSections } from './SchemaObjectSections';

let container: HTMLDivElement;
let root: Root;

const NO_CHECK_CATALOG: SchemaObjects = {
  indexes: [],
  foreignKeys: [],
  checkConstraints: null,
  ddl: null,
  triggers: [],
  failures: {}
};

beforeEach(() => {
  useLanguageStore.getState().setPreference('zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SchemaObjectSections', () => {
  // MySQL 5.7 没有 CHECK_CONSTRAINTS 目录表，结构页原先在这一段印红字原话
  it('MySQL 没有检查约束目录时说是哪个版本起才有，不说「这种数据库没有」', async () => {
    await act(async () => {
      root.render(<SchemaObjectSections objects={NO_CHECK_CATALOG} dbType={DatabaseType.MySQL} />);
    });
    expect(container.textContent).toContain(zh['schema.checks.noCatalogMysql']);
    expect(container.textContent).not.toContain(zh['schema.checks.noCatalog']);
  });

  it('SQLite 照旧', async () => {
    await act(async () => {
      root.render(<SchemaObjectSections objects={NO_CHECK_CATALOG} dbType={DatabaseType.SQLite} />);
    });
    expect(container.textContent).toContain(zh['schema.checks.noCatalogSqlite']);
  });
});
