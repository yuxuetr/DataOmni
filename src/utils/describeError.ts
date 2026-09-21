import { translateNow } from '../stores/languageStore';
/**
 * 把任意 catch 到的东西变成一句能看的消息。
 *
 * 存在的理由是 Tauri：Rust 命令返回 `Err(String)` 时，`invoke` reject 的是一个
 * **普通字符串**，不是 Error 实例。代码里到处写的
 * `error instanceof Error ? error.message : '某某失败'`
 * 会把后端说的每一句话都换成占位文案——「测试连接」失败时后端说的其实是
 * `missing field 'id'`，界面上却只有「连接配置验证失败」。
 */
export function describeError(error: unknown, fallback = translateNow('error.unknown')): string {
  if (typeof error === 'string') {
    return error.trim() || fallback;
  }

  if (error instanceof Error) {
    return error.message.trim() || fallback;
  }

  // Tauri 也可能 reject 一个带 message 的对象
  if (typeof error === 'object' && error !== null) {
    // message 是字符串就以它为准：它空着说明这个错误本来就没带信息，
    // 再把整个对象序列化出来只是噪音
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.trim() || fallback;
    }

    try {
      const serialized = JSON.stringify(error);
      // "{}" 说明对象里没有可读内容，不如直接给兜底文案
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      // 循环引用之类，落到兜底
    }
  }

  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }

  return fallback;
}
