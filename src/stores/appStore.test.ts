import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import type { ColumnInfo } from '../contracts';
import type { SchemaObjects } from '../utils/schemaObjects';
import {
  METADATA_TTL_MS,
  selectTableStructure,
  tableStructureKey,
  useAppStore
} from './appStore';

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

const STRUCTURE_COLUMNS: ColumnInfo[] = [
  { name: 'id', data_type: 'bigint', is_nullable: false, is_primary_key: true, default_value: undefined }
];

const STRUCTURE_OBJECTS: SchemaObjects = {
  indexes: [], foreignKeys: [], checkConstraints: null, ddl: null, triggers: []
};

const STRUCTURE_KEY = tableStructureKey('c1', 'public', 'orders');

describe('表结构缓存', () => {
  beforeEach(() => {
    useAppStore.setState({ tableStructures: {}, schemaVersion: 0 });
  });

  it('列写进去就读得出来——这正是切回标签时省掉四条目录查询的那一下', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)?.columns).toEqual(STRUCTURE_COLUMNS);
  });

  it('索引等随后补上，不会把已经存好的列冲掉', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { objects: STRUCTURE_OBJECTS });
    const cached = selectTableStructure(useAppStore.getState(), STRUCTURE_KEY);
    expect(cached?.columns).toEqual(STRUCTURE_COLUMNS);
    expect(cached?.objects).toEqual(STRUCTURE_OBJECTS);
  });

  it('列还没到就不建条目：一份没有列的结构缓存读出来只会让人以为读过了', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { objects: STRUCTURE_OBJECTS });
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)).toBeNull();
  });

  /** 我们自己执行完 DDL，这一份描述的就是改之前那张表了 */
  it('schemaVersion 变了就当没有这份缓存', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().markSchemaChanged();
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)).toBeNull();
  });

  /** 版本号追不上别人改的结构，所以还要一个过期时间兜底 */
  it('过期之后当没有', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    const now = Date.now();
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY, now + METADATA_TTL_MS)).not.toBeNull();
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY, now + METADATA_TTL_MS + 1)).toBeNull();
  });

  it('DDL 之后重新写入的那一份又作数了', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().markSchemaChanged();
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)).not.toBeNull();
  });

  it('作废的那一份不拿来合并：它描述的是 DDL 之前的那张表', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS, objects: STRUCTURE_OBJECTS });
    useAppStore.getState().markSchemaChanged();
    // 新版本只写了列，旧版本的 objects 不该被带过来
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)?.objects).toBeNull();
  });

  it('断开一个连接只清它自己的表，别的连接不受影响', () => {
    const other = tableStructureKey('c2', 'public', 'orders');
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().cacheTableStructure(other, 'c2', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().clearDatabaseMetadata('c1');
    expect(selectTableStructure(useAppStore.getState(), STRUCTURE_KEY)).toBeNull();
    expect(selectTableStructure(useAppStore.getState(), other)).not.toBeNull();
  });

  it('不给连接 id 就全清', () => {
    useAppStore.getState().cacheTableStructure(STRUCTURE_KEY, 'c1', { columns: STRUCTURE_COLUMNS });
    useAppStore.getState().clearDatabaseMetadata();
    expect(useAppStore.getState().tableStructures).toEqual({});
  });

  it('同名表在两个连接下是两张表', () => {
    expect(tableStructureKey('c1', 'public', 'orders'))
      .not.toBe(tableStructureKey('c2', 'public', 'orders'));
  });
});
