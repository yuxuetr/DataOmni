import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zh } from '../i18n/zh';
import { parseBackendError, translateBackendMessage } from './backendError';


describe('backendError', () => {
  it('带数据的码拆成文案键和数据两半', () => {
    const parsed = parseBackendError('DATAOMNI_UNSUPPORTED_DATABASE: MongoDB');
    expect(parsed).toEqual({ key: 'error.backend.unsupportedDatabase', detail: 'MongoDB' });
  });

  it('不带数据的码也认，数据是空串', () => {
    expect(parseBackendError('DATAOMNI_SSH_AUTH_REJECTED')).toEqual({
      key: 'error.backend.sshAuthRejected',
      detail: ''
    });
  });

  it('指纹里的冒号不会被当成分隔符', () => {
    // 只在**第一个**冒号处切开：指纹本身就长成 `SHA256:xxx`
    const parsed = parseBackendError(
      'DATAOMNI_SSH_HOST_KEY_CHANGED: SHA256:aaa → SHA256:bbb'
    );
    expect(parsed?.detail).toBe('SHA256:aaa → SHA256:bbb');
  });

  it('认不出的码返回 null，让调用方原样显示', () => {
    // 后端加了新错误而这里忘了配时走这条路——看到的是原串，不是空白
    expect(parseBackendError('DATAOMNI_SOMETHING_NEW: 细节')).toBeNull();
  });

  it('句子中间撞上大写词不算', () => {
    // 驱动的报错里有大写下划线的词是常事。把它当成码会换掉整句话，
    // 那比不翻译更糟
    expect(parseBackendError('error returned: DATAOMNI_HOST_REQUIRED')).toBeNull();
    expect(parseBackendError('connection refused')).toBeNull();
  });

  it('已有的 SESSION_PASSWORD_REQUIRED 不在表里，不能被改写', () => {
    // `useProfileConnector` 靠 `message.includes('SESSION_PASSWORD_REQUIRED')`
    // 认它。翻译掉就等于把未保存密码的连接流程拆了
    expect(parseBackendError('SESSION_PASSWORD_REQUIRED: 此连接未保存密码')).toBeNull();
  });

  it('后端定义的每个码，前端都有文案', () => {
    // 手写一份码的清单会过期，而过期的样子是界面上突然印出
    // `DATAOMNI_SSH_FAILED: ...`——所以清单直接从 Rust 源码里取
    // 扫整个后端，而不是列几个文件：码定义在哪个文件里是会变的，
    // 而「定义了就必须有文案」这条不变
    const root = fileURLToPath(new URL('../../src-tauri/src', import.meta.url));
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.rs'))
      .map((entry) => readFileSync(join(root, entry), 'utf8'))
      .join('\n');

    const codes = [...sources.matchAll(/pub const \w+: &str = "(DATAOMNI_[A-Z0-9_]+)";/g)].map(
      ([, code]) => code
    );
    expect(codes.length, '一个都没匹配到说明后端的写法变了，这道门已经失效').toBeGreaterThan(10);

    for (const code of codes) {
      const parsed = parseBackendError(code);
      expect(parsed, `后端的 ${code} 在前端没有文案`).not.toBeNull();
      expect(zh).toHaveProperty(parsed?.key as string);
    }
  });


  /**
   * 这道门挡的是**还没改成码**的那些：另一条只看 `pub const`，
   * 而一句写死的中文 `Err("连接不存在")` 它一个都看不见。
   *
   * 写到第四版才对。前三版都栽在同一件事上——**门自己有 bug，而它是静默的**：
   *
   * 1. 按行判「这一行既有 `QueryError::message` 又有中文」→ 跨行的写法全漏，
   *    `with_code(\n  CODE,\n  format!("超过 …"),\n)` 里中文在续行上。
   * 2. 改判字符串字面量，但 `println!` 括号配平算错 → 一个文件里出现第一个
   *    println 之后，后面整段都被跳过。
   * 3. 按行剥注释 → `'"'` 这种字符字面量把扫描器带进「字符串里」再也出不来，
   *    从那行起整个文件失效。
   *
   * 所以注释剥离必须放进字符遍历里，并且认得出字符字面量与生命周期标注。
   * `println!` 打终端、打包后没人看得见，中文反而好读——唯一的例外。
   */
  it('后端的字符串字面量里一个中文字都不许有', () => {
    const root = fileURLToPath(new URL('../../src-tauri/src', import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.rs'));

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      const testsFrom = lines.findIndex((line) => line.trim().startsWith('#[cfg(test)]'));
      const source = (testsFrom === -1 ? lines : lines.slice(0, testsFrom)).join('\n');

      let depth = 0;
      /** print 宏是在哪个括号深度上开始的；不在宏里就是 null */
      let printAt: number | null = null;
      let line = 1;
      let recent = '';

      for (let i = 0; i < source.length; i += 1) {
        const character = source[i];
        recent = (recent + character).slice(-12);

        if (character === '\n') {
          line += 1;
          continue;
        }
        if (character === '/' && source[i + 1] === '/') {
          while (i < source.length && source[i] !== '\n') i += 1;
          line += 1;
          continue;
        }
        if (character === '/' && source[i + 1] === '*') {
          while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
            if (source[i] === '\n') line += 1;
            i += 1;
          }
          i += 1;
          continue;
        }
        // `'"'` 这类字符字面量里的引号不是字符串边界；`&'a str` 的撇号则不成对
        if (character === "'") {
          if (source[i + 1] === '\\') {
            i += 2;
            while (i < source.length && source[i] !== "'") i += 1;
          } else if (source[i + 2] === "'") {
            i += 2;
          }
          continue;
        }
        if (character === '"') {
          const from = i;
          i += 1;
          while (i < source.length && source[i] !== '"') {
            if (source[i] === '\\') i += 1;
            i += 1;
          }
          const literal = source.slice(from, i + 1);
          if (printAt === null && /[一-鿿]/.test(literal)) {
            offenders.push(`${file}:${line} ${literal.slice(0, 50)}`);
          }
          line += (literal.match(/\n/g) ?? []).length;
          continue;
        }
        if (character === '(') {
          if (printAt === null && /\b(eprintln|println|eprint|print)!\s*$/.test(recent.slice(0, -1))) {
            printAt = depth;
          }
          depth += 1;
          continue;
        }
        if (character === ')') {
          depth -= 1;
          if (printAt !== null && depth <= printAt) printAt = null;
        }
      }
    }

    expect(offenders, '这些字符串会原样印到英文界面上').toEqual([]);
  });
});

describe('导入的行错误', () => {
  it('SQL Server 那两条码有译文，数据原样带出', () => {
    for (const code of ['DATAOMNI_CSV_VALUE_NOT_CONVERTIBLE', 'DATAOMNI_CSV_TRANSACTION_LOST']) {
      const translated = translateBackendMessage(`${code}: n · int · abc`);
      expect(translated).not.toContain(code);
      expect(translated).toContain('n · int · abc');
    }
  });
});
