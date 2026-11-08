#!/usr/bin/env bash
# 从 `cargo test --test <suite> -- --nocapture` 的输出日志中统计真实的「通过 / 跳过 / 失败」数量。
#
# cargo 自带的 `N passed` 把因未设置环境变量而提前 `return` 的用例也算作 passed；
# 冒烟用例跳过时统一在标准错误输出 `SKIP: <原因>`，这里把它们从 passed 中扣除并归入 skipped。
set -euo pipefail

if [[ "${1:-}" == "--header" ]]; then
  echo "| 用例集 | 通过 (Passed) | 跳过 (Skipped) | 失败 (Failed) |"
  echo "| --- | ---: | ---: | ---: |"
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 [--header | <suite-name> <cargo-test-log>]" >&2
  exit 2
fi

suite="$1"
log_file="$2"

result_line="$(grep -E '^test result: (ok|FAILED)\.' "$log_file" | tail -n 1 || true)"
if [[ -z "$result_line" ]]; then
  echo "| ${suite} | 0 | 0 | 1 (missing test result) |"
  exit 1
fi

cargo_passed="$(echo "$result_line" | sed -E 's/.* ([0-9]+) passed;.*/\1/')"
cargo_failed="$(echo "$result_line" | sed -E 's/.*; ([0-9]+) failed;.*/\1/')"
cargo_ignored="$(echo "$result_line" | sed -E 's/.*; ([0-9]+) ignored;.*/\1/')"
skip_printed="$(grep -c '^SKIP: ' "$log_file" || true)"

passed=$((cargo_passed - skip_printed))
if (( passed < 0 )); then
  passed=0
fi
skipped=$((cargo_ignored + skip_printed))

echo "| ${suite} | ${passed} | ${skipped} | ${cargo_failed} |"
