//! 后端自己持有的连接池，按连接串登记。
//!
//! sqlx 那三家的池子在插件的 `DbInstances` 里；插件接不了的驱动（SQL Server 的
//! tiberius、Oracle 的 ODPI-C）由 `test_connection` 连上之后登记在这里，其余命令
//! 按同一个不带口令的连接串取。和插件的 `DbInstances` 是同一个角色。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct PoolRegistry<P> {
  pools: Mutex<HashMap<String, Arc<P>>>,
}

impl<P> Default for PoolRegistry<P> {
  fn default() -> Self {
    Self { pools: Mutex::new(HashMap::new()) }
  }
}

impl<P> PoolRegistry<P> {
  pub fn insert(&self, key: String, pool: Arc<P>) {
    if let Ok(mut pools) = self.pools.lock() {
      pools.insert(key, pool);
    }
  }

  pub fn get(&self, key: &str) -> Option<Arc<P>> {
    self.pools.lock().ok().and_then(|pools| pools.get(key).cloned())
  }

  pub fn remove(&self, key: &str) -> bool {
    self.pools.lock().ok().and_then(|mut pools| pools.remove(key)).is_some()
  }
}

/// 两个自建池子（SQL Server、Oracle）的空闲连接，带着放回来的时刻。
///
/// 放得太久的不再拿出来用：VPN、NAT、云负载均衡会把空闲几分钟的 TCP 流悄悄丢掉，
/// 不发 RST。拿一条这样的连接去跑目录查询，要等满 30 秒超时，然后报一句「查询
/// 超时，调大超时」——而问题根本不在查询。回收时限与 sqlx 那两家一致
/// （`sqlx_pool::IDLE_TIMEOUT`）。
pub struct IdleConnections<T> {
  entries: Mutex<Vec<(T, std::time::Instant)>>,
  max: usize,
}

impl<T> IdleConnections<T> {
  pub fn new(first: T, max: usize) -> Self {
    Self { entries: Mutex::new(vec![(first, std::time::Instant::now())]), max }
  }

  /// 最近放回的一条还新鲜的连接；放太久的一并交回给调用方处置——Oracle 的连接
  /// 关的时候要走一次网络，不能在异步线程上直接 drop
  pub fn take(&self) -> (Option<T>, Vec<T>) {
    let Ok(mut entries) = self.entries.lock() else {
      return (None, Vec::new());
    };
    let mut stale = Vec::new();
    while let Some((connection, since)) = entries.pop() {
      if since.elapsed() < crate::services::sqlx_pool::IDLE_TIMEOUT {
        return (Some(connection), stale);
      }
      stale.push(connection);
    }
    (None, stale)
  }

  pub fn put(&self, connection: T) {
    if let Ok(mut entries) = self.entries.lock() {
      if entries.len() < self.max {
        entries.push((connection, std::time::Instant::now()));
      }
    }
  }

  #[cfg(test)]
  fn age_all(&self, by: std::time::Duration) {
    if let Ok(mut entries) = self.entries.lock() {
      for entry in entries.iter_mut() {
        entry.1 = entry.1.checked_sub(by).unwrap_or(entry.1);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_connection_idle_past_the_timeout_is_not_handed_out_again() {
    let idle = IdleConnections::new("first", 4);
    idle.age_all(crate::services::sqlx_pool::IDLE_TIMEOUT);
    idle.put("fresh");
    // 新放回的先拿到；再拿一次，放太久的那条被交回处置，而不是拿去用
    assert_eq!(idle.take(), (Some("fresh"), vec![]));
    assert_eq!(idle.take(), (None, vec!["first"]));
  }

  #[test]
  fn at_most_max_connections_wait_in_the_list() {
    let idle = IdleConnections::new(1, 2);
    idle.put(2);
    idle.put(3);
    assert_eq!(idle.take().0, Some(2));
  }
}
