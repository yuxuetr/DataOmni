import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadConnectionRecency,
  orderProfilesByRecency,
  recordConnectionUse
} from './connectionRecency';

const STORAGE_KEY = 'dataomni_connection_recency';

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    }
  });

  return store;
}

const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('连接最近使用', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    storage = installMemoryStorage();
  });

  it('没记录时返回空表', () => {
    expect(loadConnectionRecency()).toEqual({});
  });

  it('记录后可读回', () => {
    recordConnectionUse('a', 1000);
    expect(loadConnectionRecency()).toEqual({ a: 1000 });
  });

  it('同一连接再次使用会覆盖时间而不是追加', () => {
    recordConnectionUse('a', 1000);
    recordConnectionUse('a', 2000);
    expect(loadConnectionRecency()).toEqual({ a: 2000 });
  });

  it('内容坏掉时当作没有记录，不抛', () => {
    storage.set(STORAGE_KEY, '{ 不是 JSON');
    expect(() => loadConnectionRecency()).not.toThrow();
    expect(loadConnectionRecency()).toEqual({});
  });

  it('结构不对（时间不是数字）时整份丢弃', () => {
    storage.set(STORAGE_KEY, JSON.stringify({ a: 'yesterday' }));
    expect(loadConnectionRecency()).toEqual({});
  });

  it('用过的排前面，越近越前', () => {
    const ordered = orderProfilesByRecency(profiles, { a: 100, c: 300 });
    expect(ordered.map((profile) => profile.id)).toEqual(['c', 'a', 'b']);
  });

  it('没用过的保持传入顺序排在后面', () => {
    const ordered = orderProfilesByRecency(profiles, { b: 100 });
    expect(ordered.map((profile) => profile.id)).toEqual(['b', 'a', 'c']);
  });

  it('全都没用过时顺序不变', () => {
    expect(orderProfilesByRecency(profiles, {}).map((profile) => profile.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('已删除连接的残留记录不会凭空造出条目', () => {
    const ordered = orderProfilesByRecency(profiles, { deleted: 999, a: 100 });
    expect(ordered.map((profile) => profile.id)).toEqual(['a', 'b', 'c']);
  });

  it('条目数量有上限，只保留最近的 50 条', () => {
    for (let index = 0; index < 60; index += 1) {
      recordConnectionUse(`profile-${index}`, index);
    }

    const recency = loadConnectionRecency();
    expect(Object.keys(recency)).toHaveLength(50);
    // 最早的被挤掉，最近的还在
    expect(recency['profile-0']).toBeUndefined();
    expect(recency['profile-59']).toBe(59);
  });

  it('localStorage 抛错时读取回空、写入不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      }
    });

    expect(loadConnectionRecency()).toEqual({});
    expect(() => recordConnectionUse('a')).not.toThrow();
  });
});
