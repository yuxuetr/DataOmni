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
