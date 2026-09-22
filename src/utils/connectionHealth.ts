/**
 * 界面上那个连接状态标记该显示什么。
 *
 * 之前两处各判各的，而且判的是**手里有没有句柄**而不是**连接还活着没有**：
 * `queryStore.database` 是 `Database.load` 的返回值，驱动把连接判死之后它
 * 照样在那儿。于是一条查询打回 CONNECTION_LOST，工作台头部仍然写着
 * 「已连接」，浏览器侧边栏也是——而那正是最需要它说实话的时刻。
 */
export type ConnectionHealth =
  | 'connecting'
  | 'connected'
  /** 连上过，然后驱动说连接没了。和 `failed` 的区别是这次曾经能用 */
  | 'lost'
  /** 握手就没成功 */
  | 'failed'
  | 'disconnected';

export interface ConnectionHealthInputs {
  /** 握手进行中 */
  isConnecting: boolean;
  /** 驱动告诉我们这条连接已经没了 */
  connectionLost: boolean;
  /** 手里有没有 `Database` 句柄。**不代表连接还活着** */
  hasSession: boolean;
  /** 应用侧的接线做完了没有（元数据、活动连接、侧边栏选中） */
  connectionReady: boolean;
  /** 连接层面的错误；语句自己的错误不走这里 */
  error: string | null;
}

/**
 * 判断顺序是有讲究的：**`connectionLost` 必须排在最后那句「有句柄且接完线
 * 就是已连接」前面**。断线的时候句柄还在、应用侧也还是 ready，只看那两样
 * 就会得出「已连接」——那正是原来两处各自的写法。
 */
export function connectionHealth(inputs: ConnectionHealthInputs): ConnectionHealth {
  if (inputs.isConnecting) {
    return 'connecting';
  }
  if (inputs.connectionLost) {
    return 'lost';
  }
  if (!inputs.hasSession) {
    return inputs.error ? 'failed' : 'disconnected';
  }
  // 句柄有了但应用侧还没接完线（等元数据、等活动连接落位），这仍然是连接中
  return inputs.connectionReady ? 'connected' : 'connecting';
}

/**
 * 什么时候把「重新连接」摆出来。
 *
 * 断了和没连上都给：这两种状态下用户唯一能做的事就是再连一次，而在此之前
 * 「重新连接」只在 `failed` 时出现——断线之后一个按钮都没有，只能自己去
 * 侧边栏切一遍连接。
 */
export function offersReconnect(health: ConnectionHealth): boolean {
  return health === 'lost' || health === 'failed';
}
