/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_CHECK,
  isNewerVersion,
  loadUpdateCheck,
  noticeVersion,
  saveUpdateCheck,
  shouldCheckNow,
  UPDATE_CHECK_INTERVAL_MS
} from './updateCheck';

const NOW = Date.parse('2026-10-07T09:00:00Z');

describe('isNewerVersion', () => {
  it('按数字比，不按字符串比', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.5.1')).toBe(true);
    expect(isNewerVersion('0.5.1', '0.5.1')).toBe(false);
    expect(isNewerVersion('0.5.0', '0.5.1')).toBe(false);
  });

  it('同号的正式版比预发布新；预发布不比正式版新', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
  });

  it('认不出的写法一律当不更新：宁可不提示，也不乱提示', () => {
    expect(isNewerVersion('latest', '0.5.1')).toBe(false);
    expect(isNewerVersion('2', '0.5.1')).toBe(false);
    expect(isNewerVersion('1.0.0', 'dev')).toBe(false);
  });
});

describe('shouldCheckNow', () => {
  it('关掉了就不查', () => {
    expect(shouldCheckNow({ ...DEFAULT_UPDATE_CHECK, enabled: false }, NOW)).toBe(false);
  });

  it('从没查过就查；距上次不满一天不查，满了再查', () => {
    expect(shouldCheckNow(DEFAULT_UPDATE_CHECK, NOW)).toBe(true);
    expect(shouldCheckNow({ ...DEFAULT_UPDATE_CHECK, lastCheckedAt: NOW - UPDATE_CHECK_INTERVAL_MS + 1000 }, NOW)).toBe(false);
    expect(shouldCheckNow({ ...DEFAULT_UPDATE_CHECK, lastCheckedAt: NOW - UPDATE_CHECK_INTERVAL_MS }, NOW)).toBe(true);
  });

  it('上次查的时间在将来（改过系统时钟）就当没查过，不然要等到那一天', () => {
    expect(shouldCheckNow({ ...DEFAULT_UPDATE_CHECK, lastCheckedAt: NOW + 30 * UPDATE_CHECK_INTERVAL_MS }, NOW)).toBe(true);
  });
});

describe('noticeVersion', () => {
  it('有更新的版本才提示；用户关掉过的那一版不再提示，再新一版照样提示', () => {
    const state = { ...DEFAULT_UPDATE_CHECK, latestVersion: '0.6.0' };
    expect(noticeVersion(state, '0.5.1')).toBe('0.6.0');
    expect(noticeVersion(state, '0.6.0')).toBeNull();
    expect(noticeVersion({ ...state, dismissedVersion: '0.6.0' }, '0.5.1')).toBeNull();
    expect(noticeVersion({ ...state, latestVersion: '0.6.1', dismissedVersion: '0.6.0' }, '0.5.1')).toBe('0.6.1');
  });

  it('关掉检查之后，以前查到的也不再提示', () => {
    expect(noticeVersion({ ...DEFAULT_UPDATE_CHECK, enabled: false, latestVersion: '0.6.0' }, '0.5.1')).toBeNull();
  });
});

describe('loadUpdateCheck / saveUpdateCheck', () => {
  beforeEach(() => localStorage.clear());

  it('默认打开；存下的往返；坏掉的字段退回默认', () => {
    expect(loadUpdateCheck()).toEqual(DEFAULT_UPDATE_CHECK);
    expect(DEFAULT_UPDATE_CHECK.enabled).toBe(true);

    const state = { enabled: false, lastCheckedAt: NOW, latestVersion: '0.6.0', dismissedVersion: null };
    saveUpdateCheck(state);
    expect(loadUpdateCheck()).toEqual(state);

    localStorage.setItem('dataomni.update-check', JSON.stringify({ enabled: 'yes', lastCheckedAt: 'x', latestVersion: 3 }));
    expect(loadUpdateCheck()).toEqual(DEFAULT_UPDATE_CHECK);
  });
});
