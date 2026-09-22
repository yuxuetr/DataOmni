import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zh } from '../i18n/zh';
import type { ConnectionDiagnosis } from '../contracts/connectionDiagnosis';
import {
  diagnosisConclusionKey,
  diagnosisLines,
  diagnosisPassed
} from './connectionDiagnosis';

function diagnosis(
  ...steps: Array<[name: string, ok: boolean, detail?: string]>
): ConnectionDiagnosis {
  return {
    steps: steps.map(([name, ok, detail]) => ({
      name,
      ok,
      detail: detail ?? '',
      elapsedMs: 3
    }))
  };
}

describe('connectionDiagnosis', () => {
  it('解析成功而端口不通时，结论指向服务与防火墙', () => {
    const result = diagnosis(['resolve', true, '10.0.0.5'], ['tcp', false, 'Connection refused']);

    expect(diagnosisConclusionKey(result)).toBe('diagnosis.conclusion.tcpFailed');
    expect(diagnosisPassed(result)).toBe(false);
  });

  it('两步都通时，结论明说网络这一段没问题', () => {
    const result = diagnosis(['resolve', true], ['tcp', true]);

    expect(diagnosisConclusionKey(result)).toBe('diagnosis.conclusion.reachable');
    expect(diagnosisPassed(result)).toBe(true);
  });

  /**
   * 后端解析失败时**只**回一步，所以结论必须来自 `resolve` 而不是某个
   * 不存在的 `tcp`。这条钉住「结论只看最后一步」这个约定的另一半
   */
  it('解析失败时结论来自解析那一步', () => {
    expect(diagnosisConclusionKey(diagnosis(['resolve', false, 'nodename nor servname'])))
      .toBe('diagnosis.conclusion.resolveFailed');
  });

  it('四种 SQLite 文件结果各有各的结论', () => {
    expect(diagnosisConclusionKey(diagnosis(['sqliteFile', true])))
      .toBe('diagnosis.conclusion.fileOk');
    expect(diagnosisConclusionKey(diagnosis(['sqliteFile', false])))
      .toBe('diagnosis.conclusion.fileFailed');
    expect(diagnosisConclusionKey(diagnosis(['sqliteEmpty', true])))
      .toBe('diagnosis.conclusion.emptyFile');
    expect(diagnosisConclusionKey(diagnosis(['sqliteMagic', false])))
      .toBe('diagnosis.conclusion.notSqlite');
    expect(diagnosisConclusionKey(diagnosis(['sqliteMemory', true])))
      .toBe('diagnosis.conclusion.memory');
  });

  /**
   * 后端加了一步而前端还没跟上：那一行要照样显示出来。
   * 少一行意味着「诊断到这里就结束了」，而真相是前端认不出它
   */
  it('认不出的步骤仍然占一行，结论则留空而不是硬凑', () => {
    const result = diagnosis(['tlsHandshake', false, 'certificate expired']);

    expect(diagnosisLines(result)).toEqual([
      {
        titleKey: 'diagnosis.step.unknown',
        ok: false,
        detail: 'certificate expired',
        elapsedMs: 3
      }
    ]);
    expect(diagnosisConclusionKey(result)).toBeNull();
  });

  it('空结果不产生结论', () => {
    expect(diagnosisConclusionKey({ steps: [] })).toBeNull();
    expect(diagnosisPassed({ steps: [] })).toBe(false);
  });

  /**
   * 两张表里的每个键都必须真的存在于目录里。
   * TypeScript 已经保证了字面量，这条守住「表被改成动态拼键」之后的情况——
   * 那时缺的文案会在界面上变成一个键名，而没有任何测试会红
   */
  it('后端能报出的每一种步骤，前端都认得', () => {
    // 手写一份步骤清单会过期，而过期的样子是界面上多出一行「未知步骤」、
    // 末尾少一句结论——单测不看界面，所以清单直接从后端源码里取
    const probe = readFileSync(
      fileURLToPath(new URL('../../src-tauri/src/services/connection_probe.rs', import.meta.url)),
      'utf8'
    );
    const pairs = [...probe.matchAll(/DiagnosisStep::new\(\s*"(\w+)",\s*(true|false)\s*,/g)].map(
      ([, name, ok]) => ({ name, ok: ok === 'true' })
    );
    expect(pairs.length, '一条都没匹配到说明后端的写法变了，这道门已经失效').toBeGreaterThan(5);

    // 唯一允许没有结论的组合：`probe_host` 永远返回 [resolve, tcp] 两步，
    // 所以解析成功之后一定还有下一步，它当不了最后一步
    const neverLast = new Set(['resolve:true']);

    for (const { name, ok } of pairs) {
      const single = diagnosis([name, ok]);

      const [line] = diagnosisLines(single);
      expect(line.titleKey, `后端的步骤 ${name} 在前端没有标题`).not.toBe(
        'diagnosis.step.unknown'
      );
      expect(zh).toHaveProperty(line.titleKey);

      if (neverLast.has(`${name}:${ok}`)) {
        continue;
      }
      const conclusion = diagnosisConclusionKey(single);
      expect(conclusion, `${name}:${ok} 结束的诊断没有结论`).not.toBeNull();
      expect(zh).toHaveProperty(conclusion as string);
    }
  });
});
