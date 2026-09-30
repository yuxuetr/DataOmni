/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionInfoDialog } from './ConnectionInfoDialog';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import { createDefaultConfig } from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function profileOf(type: DatabaseType, database: string): ConnectionProfile {
  return {
    ...createDefaultConfig(type),
    id: 'p1',
    name: 'local',
    database,
    created_at: '',
    updated_at: '',
  };
}

function labels(): string[] {
  return [...container.querySelectorAll('.text-fg-muted')].map((element) => element.textContent ?? '');
}

describe('ConnectionInfoDialog', () => {
  it('文件库不列用户、TLS、保存密码：配置里的默认值写出来只会误导', () => {
    act(() => {
      root.render(
        <ConnectionInfoDialog connection={profileOf(DatabaseType.SQLite, '/data/app.db')} session={null} onClose={() => undefined} />
      );
    });
    expect(labels()).not.toEqual(expect.arrayContaining(['User']));
    expect(labels()).not.toEqual(expect.arrayContaining(['TLS']));
    expect(labels()).not.toEqual(expect.arrayContaining(['Save password']));
  });

  it('网络库照旧列这三项', () => {
    act(() => {
      root.render(
        <ConnectionInfoDialog connection={profileOf(DatabaseType.PostgreSQL, 'shop')} session={null} onClose={() => undefined} />
      );
    });
    expect(labels()).toEqual(expect.arrayContaining(['User', 'TLS', 'Save password']));
  });
});
