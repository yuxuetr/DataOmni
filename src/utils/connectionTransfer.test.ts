import { beforeEach, describe, expect, it } from 'vitest';
import { importSummary } from './connectionTransfer';
import { useLanguageStore } from '../stores/languageStore';

describe('导入连接之后的那句话', () => {
  beforeEach(() => {
    useLanguageStore.getState().setPreference('zh');
  });

  it('导进了连接就提醒口令不在文件里', () => {
    expect(importSummary({ imported: 2, skipped: 0 })).toContain('已导入 2 个连接');
    expect(importSummary({ imported: 2, skipped: 0 })).toContain('口令');
    expect(importSummary({ imported: 2, skipped: 1 })).toContain('1 个本机已经有了');
  });

  it('一个都没导进时说清是为什么，不提口令', () => {
    expect(importSummary({ imported: 0, skipped: 3 })).toContain('3 个连接本机都已经有了');
    expect(importSummary({ imported: 0, skipped: 3 })).not.toContain('口令');
    expect(importSummary({ imported: 0, skipped: 0 })).toContain('没有连接');
  });
});
