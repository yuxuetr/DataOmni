import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { ES_API_KEY, ES_AUTH_OPTION, isEsApiKey, withEsApiKey } from './esConnection';

describe('Elasticsearch API Key 登录', () => {
  it('只有 Elasticsearch 认这个选项', () => {
    const options = { [ES_AUTH_OPTION]: ES_API_KEY };
    expect(isEsApiKey({ db_type: DatabaseType.Elasticsearch, options })).toBe(true);
    expect(isEsApiKey({ db_type: DatabaseType.MongoDB, options })).toBe(false);
    expect(isEsApiKey({ db_type: DatabaseType.Elasticsearch, options: {} })).toBe(false);
  });

  it('换成 API Key 清掉用户名和口令，别的选项不动', () => {
    const toggled = withEsApiKey({ options: { other: 'x' }, username: 'elastic', password: 'secret' }, true);
    expect(toggled).toEqual({ options: { other: 'x', [ES_AUTH_OPTION]: ES_API_KEY }, username: '', password: '' });
  });

  it('换回口令去掉选项、清掉那一格里的 key，用户名留着', () => {
    const toggled = withEsApiKey({ options: { [ES_AUTH_OPTION]: ES_API_KEY }, username: '', password: 'a2V5' }, false);
    expect(toggled).toEqual({ options: {}, username: '', password: '' });
    expect(withEsApiKey({ options: {}, username: 'elastic', password: 'p' }, false).username).toBe('elastic');
  });
});
