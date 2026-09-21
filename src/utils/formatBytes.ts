/**
 * 字节数给人看，不是给机器看：几百万行时 8777798 读不出量级。
 *
 * 导出进度、导入的文件大小、后台任务的进度三处要的是同一句话，
 * 各写一份的结果是同一个数字在三个地方长得不一样。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
