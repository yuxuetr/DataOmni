import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  ORACLE_CONNECT_BY_OPTION,
  ORACLE_DEFAULT_SERVICE,
  ORACLE_SID,
  isOracleSid,
  withOracleSid
} from './oracleConnection';

describe('Oracle 按 SID 连接', () => {
  it('只有 Oracle 认这个选项', () => {
    const options = { [ORACLE_CONNECT_BY_OPTION]: ORACLE_SID };
    expect(isOracleSid({ db_type: DatabaseType.Oracle, options })).toBe(true);
    expect(isOracleSid({ db_type: DatabaseType.PostgreSQL, options })).toBe(false);
    expect(isOracleSid({ db_type: DatabaseType.Oracle, options: {} })).toBe(false);
  });

  it('切换只动这一个选项，填过的名字留着', () => {
    expect(withOracleSid({ options: { other: 'x' }, database: 'ORCL' }, true)).toEqual({
      options: { other: 'x', [ORACLE_CONNECT_BY_OPTION]: ORACLE_SID },
      database: 'ORCL'
    });
    expect(
      withOracleSid({ options: { other: 'x', [ORACLE_CONNECT_BY_OPTION]: ORACLE_SID }, database: 'ORCL' }, false)
    ).toEqual({ options: { other: 'x' }, database: 'ORCL' });
  });

  it('预填的 FREEPDB1 是个 PDB，没有 SID：换成 SID 清掉，换回来再填上', () => {
    const sid = withOracleSid({ options: {}, database: ORACLE_DEFAULT_SERVICE }, true);
    expect(sid.database).toBe('');
    expect(withOracleSid(sid, false).database).toBe(ORACLE_DEFAULT_SERVICE);
  });
});
