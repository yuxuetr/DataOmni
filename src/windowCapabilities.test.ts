import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 前端调到的窗口方法，都要在 capabilities 里放行。
 *
 * Tauri 2 的 `core:default` 只给窗口读状态、听事件的权限，`destroy()` 这类会被
 * 拒绝——而拒绝是一个被 catch 住的 Promise，界面上什么也不发生。关窗就是这样坏
 * 掉的：红色关闭钮和 ⇧⌘W 先断开了所有连接，然后窗口原样留着。
 *
 * 判据：`appWindow.xxx(` 这种调用（`on` 开头的是监听，不需要单独放行），
 * 换成 `core:window:allow-xxx`（驼峰转短横线）必须出现在 default.json 里。
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function windowPermissionsUsed(source: string): string[] {
  return [...source.matchAll(/\bappWindow\.([a-zA-Z]+)\(/g)]
    .map((match) => match[1])
    .filter((method) => !method.startsWith('on'))
    .map((method) => `core:window:allow-${method.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}

describe('窗口方法都有权限', () => {
  it('判据能从调用推出权限名', () => {
    expect(windowPermissionsUsed('await appWindow.destroy(); appWindow.onCloseRequested(f); appWindow.setAlwaysOnTop(true)'))
      .toEqual(['core:window:allow-destroy', 'core:window:allow-set-always-on-top']);
  });

  it('src 里用到的都在 default.json 里', () => {
    const granted = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')).permissions as string[];
    const missing = sourceFiles('src')
      .flatMap((file) => windowPermissionsUsed(readFileSync(file, 'utf8')).map((permission) => ({ file, permission })))
      .filter(({ permission }) => !granted.includes(permission));
    expect(missing).toEqual([]);
  });
});
