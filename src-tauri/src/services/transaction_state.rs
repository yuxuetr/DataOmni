//! 一条 session 连接上的事务状态。
//!
//! 谁是权威：**执行语句的那条连接**。三种方言都没有一个可移植的「我在不在
//! 事务里」的查询——PostgreSQL 的 `txid_current_if_assigned()` 对只读事务
//! 返回 NULL，MySQL 没有对应的会话变量，SQLite 的 `sqlite3_get_autocommit()`
//! 在 sqlx 里取不到。而 session 连接看得见在它上面跑过的每一条语句，
//! 所以状态从语句本身推出来。
//!
//! 只有**执行成功**的语句才改状态：一条失败的 `BEGIN` 什么也没开，
//! 按它改状态会让状态栏说一件没发生的事。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionStatus {
  Idle,
  Active,
  /// 事务还开着，但已经废了：后续语句一律失败，只有回滚能出去。
  /// 只有 PostgreSQL 有这个状态——MySQL 与 SQLite 在语句出错后事务照常可用。
  Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionState {
  pub status: TransactionStatus,
  /// 事务开始的时刻，RFC 3339；不在事务里就是 `None`
  pub started_at: Option<String>,
}

impl Default for TransactionState {
  fn default() -> Self {
    Self { status: TransactionStatus::Idle, started_at: None }
  }
}

/// 一条语句对事务做了什么
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionEffect {
  Begin,
  End,
  None,
}

impl TransactionState {
  pub fn in_transaction(&self) -> bool {
    !matches!(self.status, TransactionStatus::Idle)
  }

  /// 语句跑成功之后。`now` 由调用方给，这样这段逻辑能被直接测。
  ///
  /// `ddl_commits` 只有 MySQL 是真，见 [`commits_implicitly`]。
  pub fn after_success(&mut self, sql: &str, now: &str, ddl_commits: bool) {
    if ddl_commits && commits_implicitly(sql) {
      // 事务到此为止了，不管我们发没发过 COMMIT
      self.status = TransactionStatus::Idle;
      self.started_at = None;
      return;
    }

    match transaction_effect(sql) {
      TransactionEffect::Begin => {
        // 已经在事务里又 BEGIN：PostgreSQL 只是警告，开始时间仍是最初那次。
        // 覆盖成现在会让状态栏上的计时凭空归零
        if !self.in_transaction() {
          self.status = TransactionStatus::Active;
          self.started_at = Some(now.to_string());
        }
      }
      TransactionEffect::End => {
        self.status = TransactionStatus::Idle;
        self.started_at = None;
      }
      TransactionEffect::None => {
        // 废掉的事务里只有 `ROLLBACK TO SAVEPOINT` 能成功，而它正是解除废止
        // 的那条语句。任何一条在 Failed 下成功的语句都说明事务又能用了
        if self.status == TransactionStatus::Failed {
          self.status = TransactionStatus::Active;
        }
      }
    }
  }

  /// 语句失败之后。
  ///
  /// `aborts_on_error` 只有 PostgreSQL 是真：它在事务里任何一条语句出错之后
  /// 就进入 aborted，后续语句全部报 25P02。MySQL 与 SQLite 不是这样，
  /// 在那两家标成 Failed 是在说假话。
  pub fn after_failure(&mut self, aborts_on_error: bool) {
    if aborts_on_error && self.in_transaction() {
      self.status = TransactionStatus::Failed;
    }
  }
}

/// 这条语句会不会**隐式提交**当前事务。
///
/// MySQL 的 DDL 与权限语句都会：`BEGIN; UPDATE …; DROP TABLE t;` 里那条
/// DROP 不只是自己撤不回来，它会把前面那条 UPDATE 一起提交掉。
/// PostgreSQL 与 SQLite 的 DDL 是事务性的，没有这回事。
///
/// 不认出来的后果不只是状态栏说假话：`begin_if_needed` 靠
/// `in_transaction()` 决定要不要补 BEGIN，状态停在 Active 的话，DDL 之后
/// 的下一条写入**不会**被放进事务，而界面仍然显示「事务中」。
///
/// 前端有一份同样的表（`src/utils/statementReversibility.ts`），回答的是
/// 另一个问题——执行**之前**要不要向用户承诺可以回滚。两处都照 MySQL 文档
/// 的隐式提交清单写。
fn commits_implicitly(sql: &str) -> bool {
  const IMPLICIT_COMMIT: [&str; 13] = [
    "CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE", "ANALYZE", "OPTIMIZE",
    "REPAIR", "FLUSH", "LOCK", "UNLOCK",
  ];
  let (first, _) = leading_keywords(sql);
  IMPLICIT_COMMIT.contains(&first.as_str())
}

/// 只看开头的一两个关键字。
///
/// 跳过注释：`-- 开始事务\nBEGIN` 的第一个词是 BEGIN，不是 `--`。
pub fn transaction_effect(sql: &str) -> TransactionEffect {
  let (first, second) = leading_keywords(sql);
  match first.as_str() {
    "BEGIN" => TransactionEffect::Begin,
    // MySQL 的 `START TRANSACTION`。单独一个 START 不是事务语句
    "START" if second == "TRANSACTION" => TransactionEffect::Begin,
    "COMMIT" | "END" => TransactionEffect::End,
    // `ROLLBACK TO [SAVEPOINT] x` 回到保存点，**事务还开着**。
    // 当成结束会让状态栏在事务仍然开着的时候说「已结束」
    "ROLLBACK" if second != "TO" => TransactionEffect::End,
    _ => TransactionEffect::None,
  }
}

/// 开头的两个关键字，全大写。跳过空白、`--` 行注释与 `/* */` 块注释。
fn leading_keywords(sql: &str) -> (String, String) {
  let mut rest = sql;
  let mut keywords = Vec::with_capacity(2);

  while keywords.len() < 2 {
    rest = skip_ignorable(rest);
    let word: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    if word.is_empty() {
      break;
    }
    rest = &rest[word.len()..];
    keywords.push(word.to_ascii_uppercase());
  }

  let mut iter = keywords.into_iter();
  (iter.next().unwrap_or_default(), iter.next().unwrap_or_default())
}

fn skip_ignorable(sql: &str) -> &str {
  let mut rest = sql.trim_start();
  loop {
    if let Some(after) = rest.strip_prefix("--") {
      rest = after.find('\n').map_or("", |index| &after[index + 1..]).trim_start();
      continue;
    }
    if let Some(after) = rest.strip_prefix("/*") {
      rest = after.find("*/").map_or("", |index| &after[index + 2..]).trim_start();
      continue;
    }
    return rest;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: &str = "2026-09-21T00:00:00Z";

  #[test]
  fn recognises_every_way_to_open_and_close_a_transaction() {
    for sql in ["BEGIN", "begin transaction", "BEGIN DEFERRED", "START TRANSACTION"] {
      assert_eq!(transaction_effect(sql), TransactionEffect::Begin, "{sql}");
    }
    for sql in ["COMMIT", "commit work", "ROLLBACK", "ROLLBACK TRANSACTION", "END"] {
      assert_eq!(transaction_effect(sql), TransactionEffect::End, "{sql}");
    }
    for sql in ["SELECT 1", "SAVEPOINT s", "STARTED", "COMMITTED"] {
      assert_eq!(transaction_effect(sql), TransactionEffect::None, "{sql}");
    }
  }

  /// 回到保存点不结束事务。当成结束，状态栏会在事务仍然开着的时候说它结束了，
  /// 而那正是最需要它说实话的时刻。
  #[test]
  fn rolling_back_to_a_savepoint_stays_inside_the_transaction() {
    assert_eq!(transaction_effect("ROLLBACK TO SAVEPOINT s"), TransactionEffect::None);
    assert_eq!(transaction_effect("rollback to s"), TransactionEffect::None);
  }

  #[test]
  fn comments_before_the_statement_do_not_hide_it() {
    assert_eq!(transaction_effect("-- 开始\nBEGIN"), TransactionEffect::Begin);
    assert_eq!(transaction_effect("/* 收尾 */ COMMIT"), TransactionEffect::End);
    assert_eq!(transaction_effect("  /*a*/ -- b\n  START TRANSACTION"), TransactionEffect::Begin);
  }

  #[test]
  fn a_second_begin_keeps_the_original_start_time() {
    // 覆盖成现在会让状态栏上的计时凭空归零，而事务其实已经开了很久
    let mut state = TransactionState::default();
    state.after_success("BEGIN", NOW, false);
    state.after_success("BEGIN", "2026-09-21T01:00:00Z", false);
    assert_eq!(state.started_at.as_deref(), Some(NOW));
  }

  #[test]
  fn postgres_marks_the_transaction_failed_but_the_others_do_not() {
    let mut postgres = TransactionState::default();
    postgres.after_success("BEGIN", NOW, false);
    postgres.after_failure(true);
    assert_eq!(postgres.status, TransactionStatus::Failed);

    let mut mysql = TransactionState::default();
    mysql.after_success("BEGIN", NOW, true);
    mysql.after_failure(false);
    assert_eq!(mysql.status, TransactionStatus::Active);
  }

  #[test]
  fn a_failure_outside_a_transaction_changes_nothing() {
    let mut state = TransactionState::default();
    state.after_failure(true);
    assert_eq!(state, TransactionState::default());
  }

  /// 废掉的事务里只有回到保存点能成功，所以「成功了一条」就等于「又能用了」
  #[test]
  fn succeeding_again_clears_the_failed_state_without_ending_the_transaction() {
    let mut state = TransactionState::default();
    state.after_success("BEGIN", NOW, false);
    state.after_failure(true);
    state.after_success("ROLLBACK TO SAVEPOINT s", "2026-09-21T02:00:00Z", false);
    assert_eq!(state.status, TransactionStatus::Active);
    assert_eq!(state.started_at.as_deref(), Some(NOW), "回到保存点不重开事务");
  }

  /// MySQL 的 DDL 会隐式提交。状态停在 Active 的话，`begin_if_needed` 会以为
  /// 还在事务里，于是 DDL 之后的下一条写入**不会**被放进事务，而状态栏仍然
  /// 写着「事务中」——用户以为能回滚，实际每条都已经落库
  #[test]
  fn mysql_ddl_ends_the_transaction_even_though_nobody_sent_commit() {
    // 带注释的那条也要认出来：`leading_keywords` 会跳过它，
    // 而按 `split_whitespace` 取第一个词的话第一个词是 `/*`
    for sql in
      ["DROP TABLE orders", "alter table orders add column note text", "/* 收尾 */ TRUNCATE t"]
    {
      let mut state = TransactionState::default();
      state.after_success("BEGIN", NOW, true);
      state.after_success(sql, "2026-09-21T02:00:00Z", true);
      assert_eq!(state, TransactionState::default(), "{sql}");
    }
  }

  /// 同一条语句在 PostgreSQL / SQLite 上是事务性的，`DROP TABLE` 能回滚。
  /// 在那两家把事务标成结束，回滚按钮会在还能回滚的时候变灰
  #[test]
  fn the_same_ddl_stays_inside_the_transaction_on_the_other_two() {
    let mut state = TransactionState::default();
    state.after_success("BEGIN", NOW, false);
    state.after_success("DROP TABLE orders", "2026-09-21T02:00:00Z", false);
    assert_eq!(state.status, TransactionStatus::Active);
    assert_eq!(state.started_at.as_deref(), Some(NOW));
  }

  /// DDL 之外的写入不隐式提交——把它们也算进去，回滚按钮会在真的能回滚的
  /// 时候变灰，而这正是一批 DELETE 改错之后最需要它的时刻
  #[test]
  fn ordinary_writes_are_not_implicit_commits() {
    for sql in ["DELETE FROM orders", "UPDATE t SET note = 'x'", "INSERT INTO t VALUES (1)"] {
      let mut state = TransactionState::default();
      state.after_success("BEGIN", NOW, true);
      state.after_success(sql, "2026-09-21T02:00:00Z", true);
      assert_eq!(state.status, TransactionStatus::Active, "{sql}");
    }
  }

  #[test]
  fn ending_clears_the_start_time() {
    let mut state = TransactionState::default();
    state.after_success("BEGIN", NOW, false);
    state.after_success("COMMIT", NOW, false);
    assert_eq!(state, TransactionState::default());
  }
}
