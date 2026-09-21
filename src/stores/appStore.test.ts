import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import { useAppStore } from './appStore';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: '测试库',
  db_type: DatabaseType.PostgreSQL,
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  username: 'postgres',
  password: '',
  ssl: false,
  save_password: true,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

describe('连接表单弹窗', () => {
  beforeEach(() => {
    useAppStore.getState().closeConnectionForm();
  });

  it('不带参数时以新建模式打开', () => {
    useAppStore.getState().openConnectionForm();
    expect(useAppStore.getState().connectionForm).toEqual({ mode: 'create' });
  });

  it('带配置时以编辑模式打开', () => {
    useAppStore.getState().openConnectionForm(profile);
    expect(useAppStore.getState().connectionForm).toEqual({ mode: 'edit', connection: profile });
  });

  it('传进来的不是配置时仍按新建处理', () => {
    // 把这个动作直接挂到 onClick 上，React 传的是 MouseEvent：它是真值，
    // 会让表单以「编辑」模式打开一个事件对象——标题写着「编辑数据库连接」、
    // 没有选中任何数据库类型。TypeScript 看不见这个错，因为 `() => void`
    // 的调用点允许多传实参。
    const notAProfile = { type: 'click', bubbles: true } as unknown as ConnectionProfile;

    useAppStore.getState().openConnectionForm(notAProfile);
    expect(useAppStore.getState().connectionForm).toEqual({ mode: 'create' });
  });
});

describe('库结构缓存', () => {
  const relations = [
    { schema: 'public', name: 'orders', kind: 'table' as const, columns: [] }
  ];

  beforeEach(() => {
    useAppStore.getState().clearDatabaseMetadata();
    useAppStore.getState().setDatabaseMetadata('profile-1', { objects: [], lastUpdated: 1 });
    useAppStore.getState().setCompletionCatalog('profile-1', { relations, schemaVersion: 0 });
  });

  it('清一个连接时，对象目录与补全目录一起清', () => {
    // 两者描述的是同一个库的结构。只清一半，补全会继续拿已经失效的表名
    // 往外提示，而界面上没有任何迹象表明它是旧的。
    useAppStore.getState().clearDatabaseMetadata('profile-1');
    expect(useAppStore.getState().databaseMetadata['profile-1']).toBeUndefined();
    expect(useAppStore.getState().completionCatalogs['profile-1']).toBeUndefined();
  });

  it('清全部时同样两边都清', () => {
    useAppStore.getState().clearDatabaseMetadata();
    expect(useAppStore.getState().completionCatalogs).toEqual({});
  });

  it('清某个连接不影响别的连接', () => {
    useAppStore.getState().setCompletionCatalog('profile-2', { relations, schemaVersion: 0 });
    useAppStore.getState().clearDatabaseMetadata('profile-1');
    expect(useAppStore.getState().completionCatalogs['profile-2']?.relations).toEqual(relations);
  });
});
