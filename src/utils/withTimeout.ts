/**
 * 给一个不可取消的等待加一个上限。
 *
 * `invoke('test_connection')` 和建立会话都没有超时：TCP 连得上但握手卡住时
 * （防火墙吞包、TLS 协商挂起、服务端不回应），Promise 会一直挂着。此时界面上
 * `connectingProfileId` 永远不复位，所有连接行保持 disabled——点哪一行都没反应，
 * 也没有任何提示。
 *
 * 底层的 Promise 无法真正取消，这里只让界面能恢复；它若最终成功，连接照样生效。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      }
    );
  });
}
