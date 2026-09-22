# SSH Tunnel 设计说明

> 这份文档**跟着代码走**。与 `rfcs/design.md`（2025-06 立项记录，已不跟代码）
> 不同：验收标准写成可执行的门，实现完成后这里的每一条都应当能被指着跑一遍。
>
> 立项日期：2026-09-22。当前状态：**第二个增量已实现**。
> 第一个增量落在 `3d760cf`（后端）与 `2a43375`（前端与接线）；第二个增量
> 把钥匙串里的第二份密钥接上，于是**带口令的私钥**与**口令登录**都能用了
> （2026-09-23）。§7 的验收门都已落地并反向验证过。

## 1. 为什么现在做

云上数据库通常只监听内网地址，跳板机是唯一入口。这不是假想的场景——它已经在
本仓库里留下了两处痕迹：

1. `error.portTooLargeDetail` 那条文案（已于 `f6464ae` 删掉）曾经建议用户
   「使用 SSH 端口转发：`ssh -L 3306:host:port user@jump-server`」。也就是说
   本项目自己已经把 SSH 转发当成过一种正常用法，只不过是让用户在应用之外搭。
2. `connection_probe.rs` 的 `tcpDropped` 那一步（`6ea1f3f`）就是验证隧道环境
   时被逼出来的：只监听 `127.0.0.1` 的库，从外面看不出「没有服务」还是
   「连上了」。

用户现在要做的事是：开一个终端敲 `ssh -L`，记住本地端口，再回到应用里连
`127.0.0.1:<那个端口>`。隧道断了应用只会说「连不上」。

## 2. 已验证的事实

动手前先把约束钉住，避免设计建立在猜测上。以下每条都在 2026-09-22 实测过。

| 事实 | 怎么验的 | 影响 |
| --- | --- | --- |
| 本地监听端口可以用操作系统随机分配的（49152+） | `f6464ae`：端口上限是 65535 不是 32767，`tauri-plugin-sql` 全程只传 URL 字符串 | 不用自己管端口池，`bind("127.0.0.1:0")` 即可 |
| `russh 0.63.3` 够用，且 rustc 1.98.1 满足它的 1.89 下限 | `cargo info russh` | 依赖只加 `russh` 一项（`russh-keys` 已并入） |
| `check_known_hosts(host, port, pubkey)` 的三种返回正好对应要区分的三种情形 | 读 `russh-0.63.3/src/keys/known_hosts.rs` | 见 §5 |
| 无口令私钥不需要第二份钥匙串密钥 | `ssh-keygen -y -P "" -f ~/.ssh/id_rsa` 通过 | 第一个增量可以不动钥匙串键的命名方案 |
| 目标服务器 `allowtcpforwarding yes`、`permitopen any`、`gatewayports no` | `sshd -T` | `direct-tcpip` 可用，反向转发不可用（也不需要） |

## 3. 不做什么

- **不解析 `~/.ssh/config`。** 用户要填的是主机、端口、用户名、私钥路径，
  而不是 `cu` 这样的 Host 别名。理由：ssh_config 的求值规则（`Match`、
  `Include`、`ProxyJump`、通配 `Host`）是一个完整的小语言，实现一半比不实现
  更糟——别名解析错了，用户会以为连的是 A 其实连的是 B。
  **重估条件**：出现第二个需要读它的功能时一起做。
- **不做多级跳板（`ProxyJump`）。** 一跳覆盖当前场景；第二跳是把
  `direct-tcpip` 换成在第一条会话里再开一条会话，是独立的一件事。
  **重估条件**：出现一个真的需要两跳才够得着的库。
- **不做动态转发（SOCKS）与反向转发。** 没有消费者。
- **不做 SSH 掉线自动重连。** 只负责**报出来**：隧道死了就把连接标成断开，
  让用户重连。自动重连要先回答「重连期间已经发出去的查询怎么办」，那是连接池
  的问题，不是隧道的问题；而 `queryStore.connectionLost` 那一轮（`d8c95cc`）
  已经把「断了」显示出来并给了一个真的会重连的按钮，用户手上不缺路。
  **重估条件**：出现「隧道频繁掉线」的实测记录——不是「可能会掉」。
- **不走 ssh-agent。** 第二个增量之后，带口令的私钥可以直接用（口令进钥匙串），
  agent 省掉的那一步已经没有了。接 agent 要处理 `SSH_AUTH_SOCK` 不存在、
  agent 里有多把钥匙、以及 agent 拒签时报什么——都是新的失败面。
  **重估条件**：出现一把**应用读不到**的私钥（硬件密钥 / FIDO 常驻密钥），
  那时 agent 是唯一的路。

## 4. 数据模型

`ConnectionProfile` 增加一个可选字段。可选是关键：没有隧道的连接完全不进这套
代码，`to_connection_string` 仍然是纯函数。

```rust
pub enum SshAuthMethod { PrivateKey, Password }

pub struct SshTunnelConfig {
  pub host: String,
  pub port: u16,            // 默认 22
  pub username: String,
  pub private_key_path: String,
  pub auth: SshAuthMethod,
  /// 按 `auth` 决定含义：私钥的解锁口令，或登录口令。
  /// 只在**提交的那一次**有值，落盘前清空
  pub secret: String,
  pub secret_ref: Option<String>,
  /// 转发到哪：从**服务器**的角度看的地址。
  /// 留空时用 profile 自己的 host / port——这是最常见的情形
  pub remote_host: Option<String>,
  pub remote_port: Option<u16>,
}
```

**第二个增量（已实现）**：第二份钥匙串密钥的键是 `{profile_id}#ssh`——`#` 不会
出现在 uuid 里，所以它和任何一个 profile 自己的键都撞不上，已保存的数据库密码
一条都不用迁移。

两件事共用**一条**条目，因为它们不会同时需要：用私钥登录时它是解锁私钥的口令，
用口令登录时它就是登录口令。`auth` 写成枚举而不是「私钥路径填了就用私钥」：
后者把两种模式压在一个字段的空与非空上，界面上该填哪几格没法在类型上说清，
而用口令登录的人会对着一个必填的「私钥路径」不知道填什么。

读私钥的三种失败要分开报（`SSH_PRIVATE_KEY_LOCKED` / `_PASSPHRASE` /
`_UNREADABLE`），因为用户的下一步完全不同：去填那一格、去改那一格、去查文件。
全报成「私钥读不了」的后果是**最常见的一种**——给密钥加了口令——看起来像
文件坏了。

界面**不把存着的口令回填**，所以「那一格是空的」不等于「没有口令」：保存时
留空就沿用钥匙串里那一份，填了才替换；隧道被关掉时那份条目一并删除。

## 5. 主机密钥校验

不校验 known_hosts 的 SSH 客户端可以被中间人劫持，而且劫持成功时功能
**看起来是正常的**。这正是 P0 0.2 清理的那一类问题，所以这一步不能省，也不能
有「跳过校验」的开关。

`check_known_hosts` 的返回直接对应三种处置：

| 返回 | 含义 | 处置 |
| --- | --- | --- |
| `Ok(true)` | 有记录且匹配 | 继续 |
| `Err(KeyChanged { line })` | 有同算法的记录但密钥不同 | **拒绝**，报出 known_hosts 的行号 |
| `Ok(false)` | 没有记录 | **拒绝**，把指纹显示出来，另给一个明确的「信任这台主机」动作（调 `learn_known_hosts`） |

「信任这台主机」是用户的一次显式动作，不是一个默认勾选项，也不会在连接流程里
自动发生。

## 6. 生命周期

这是整件事里唯一的架构改动。现在 `test_connection` 是「算出一个连接串」，
没有副作用；有隧道之后连接串指向 `127.0.0.1:<本地端口>`，而那个端口的存在
依赖一条活着的 SSH 会话——连接串从纯函数的产物变成了一个带资源的句柄。

```
TunnelRegistry: Mutex<HashMap<ProfileId, ActiveTunnel>>   // Tauri 管理的 state
ActiveTunnel { local_port: u16, shutdown: oneshot::Sender<()>, session: Arc<russh::client::Handle> }
```

- **建立**：`ensure_tunnel(profile)` → 已有且活着就复用，否则新建。
  `bind("127.0.0.1:0")` 拿端口，每个进来的 TCP 连接开一条
  `channel_open_direct_tcpip`，双向拷贝。
- **拆除**：`disconnect` 命令里拆掉；应用退出时把 registry 清空。
- **掉线**：转发任务发现 SSH 会话没了就把该条目从 registry 移除，并发一个事件
  让前端把连接标成断开。下一次请求会重新建立。

**只监听 `127.0.0.1`**，不监听 `0.0.0.0`——本地端口上没有任何认证，绑到
外部地址等于把跳板机后面的数据库开放给同一个网络里的所有人。

## 7. 验收标准

每一条都是一条命令的退出码，并且都要反向验证（造一个该红的输入确认它红）。

### 7.1 纯函数的门（`cargo test`，不需要网络）

1. **转发目标的默认值**：`remote_host` / `remote_port` 留空时取 profile 自己的
   host / port；填了就用填的。
2. **连接串指向本地端口**：有隧道时 `to_connection_string` 的产物必须是
   `127.0.0.1:<local_port>`，而**不是** profile 里的 host——写错这一条的表现
   是隧道建起来了但没人走它，而连接照样成功（因为库恰好也能直连），
   于是这个功能看起来是好的。
3. **主机密钥三种处置各一条**：用临时的 known_hosts 文件，分别造出匹配、
   不匹配、无记录三种情况。
4. **读私钥的三种失败各一条**（第二个增量）：测试里现造一把带口令的 ed25519
   私钥（`ssh-key` 的 `rand_core` + `encryption`，dev-dependency），分别验
   「有口令没填」「口令不对」「文件不在」。现造而不是在仓库里放一个密钥文件：
   那种文件会被密钥扫描器报，而且一份固定样本只覆盖一种算法。
5. **钥匙串的键不撞车**（第二个增量）：`{id}#ssh` 与 `{id}` 各存各的，
   保存一次 SSH 口令之后数据库密码仍然取得回来；口令不落盘；编辑时留空不丢；
   关掉隧道时删除。四条都在 `connection_service.rs` 的单测里。

### 7.2 连真实 sshd 的门（默认静默跳过）

按 `database_smoke.rs` 已有的模式，加 `src-tauri/tests/ssh_tunnel_smoke.rs`，
环境变量只在 shell 里传，**不写进任何文件**：

```
DATAOMNI_REQUIRE_SSH_TUNNEL_TESTS=1
DATAOMNI_SSH_TUNNEL_HOST=...
DATAOMNI_SSH_TUNNEL_PORT=22                     # 可选，默认 22
DATAOMNI_SSH_TUNNEL_USER=...
DATAOMNI_SSH_TUNNEL_KEY=/Users/me/.ssh/id_rsa   # 私钥，写绝对路径
DATAOMNI_SSH_TUNNEL_KEY_PASSPHRASE=...          # 可选：私钥带口令时设
DATAOMNI_SSH_TUNNEL_PASSWORD=...                # 可选：验口令登录那条路时设
DATAOMNI_SSH_TUNNEL_TARGET=127.0.0.1:23306      # 从服务器看过去的地址
DATAOMNI_SSH_TUNNEL_DB_USER=root
DATAOMNI_SSH_TUNNEL_DB_PASSWORD=...
DATAOMNI_SSH_TUNNEL_DB_NAME=dataomni_tunnel
```

**写成 `env A=1 B=2 … cargo test` 一行，不要用反斜杠续行。** 断了一截的话
变量会落在上一条命令里；`cargo test` 输出里静默跳过和全绿长得一模一样
（都是 `ok`，而跳过的理由写在默认不显示的 stderr 上）。为此
`intends_to_run()` 规定：只要出现任何一个 `DATAOMNI_SSH_TUNNEL_*`，缺的
变量就报错而不是跳过。这一条实际救过一次——七个变量设了六个，唯独
REQUIRE 落在了上一条命令里，那次运行什么都没验，报出来是全绿。

1. **该绿**：经隧道能读到 `tunnel_marker` 那一行
   （`reached-through-ssh-tunnel`）。
2. **该红**：不建隧道、直接连 `DATAOMNI_SSH_TUNNEL_TARGET` 必须失败。
   这一条是整套验收的地基——**如果目标库能被直连，那么第 1 条在隧道完全没起
   作用的情况下也会是绿的**，整个功能就没有被验证过。
3. **拆除**：隧道关掉之后本地端口必须不再接受连接。
4. **口令登录**（第二个增量，可选）：设了 `DATAOMNI_SSH_TUNNEL_PASSWORD` 才跑——
   多数跳板机的 sshd 关着 `PasswordAuthentication`，把它设成必需会让这套用例
   在正常环境里红在一件与本项目无关的事情上。同一条用例验两侧：对的口令建得起
   隧道，**错的口令必须被拒**。只验前者的话，一个完全不看口令的实现也会是绿的。

### 7.3 验证环境（已搭好）

`ssh cu`（154.44.16.42）上的 `dataomni-tunnel-mysql` 容器：
`mysql:8.4`，**只监听 `127.0.0.1:23306`**，库 `dataomni_tunnel`，
里面一张 `tunnel_marker` 表。

「只监听 127.0.0.1」是这套环境的全部意义所在，已经实测过三种情形：

| 情形 | 结果 |
| --- | --- |
| 从本机直连 `154.44.16.42:23306` | 收到 0 字节——没有服务（本机 TUN 代理会替它完成握手，所以不能只看 `connect()` 成功，见 `6ea1f3f`） |
| 经 `ssh -L` | 收到真的 MySQL 8.4.11 握手包 |
| 隧道拆掉后连本地端口 | Connection refused |

判据按 §7.2 第 2 条的要求写成「必须收到真实的协议握手」，而不是
「`connect()` 返回成功」——后者在开着 TUN 模式代理的机器上永远为真。

**验口令登录用的是一台一次性的 sshd**，不动 `cu` 自己的 sshd 配置（在一台真
服务器上打开 `PasswordAuthentication` 不是一件为了跑测试该做的事）：

```bash
# 只绑宿主机的 127.0.0.1，不对外暴露；从本机经 ssh -L 2222:127.0.0.1:2222 cu 够到它
docker run -d --name dataomni-sshd -p 127.0.0.1:2222:2222 \
  -e PUID=1000 -e PGID=1000 -e USER_NAME=tunneluser -e USER_PASSWORD=... \
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=false lscr.io/linuxserver/openssh-server
docker exec dataomni-sshd sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' \
  /config/sshd/sshd_config && docker restart dataomni-sshd
```

两处踩过的坑都记在这里：**`PUID=0` 会让这个账号成为 uid 0**，而 sshd 默认
`PermitRootLogin prohibit-password`，于是口令登录被拒，看起来像口令不对；
这个镜像默认 **`AllowTcpForwarding no`**，认证过了但通道开不出来，表现是
「本地端口上没有 MySQL 在应答」。转发目标用 MySQL 容器在 docker 网桥上的地址
（`172.17.0.x:3306`），它同样是本机直连不到的，§7.2 第 2 条那道地基还成立。

跑完把容器删掉（`docker rm -f dataomni-sshd`）：它带着一个没人再记得的口令。

## 8. 界面

连接表单加一个可折叠的「SSH 隧道」段，默认收起。里面：开关、主机、端口、
用户名、**登录方式（私钥 / 口令）**、私钥路径（带文件选择，只在选私钥时出现）、
**口令**（按登录方式换标签：私钥口令 / SSH 登录口令）、转发目标（留空则用上面
的主机端口）。

口令那一格下面的说明跟着状态走：钥匙串里已经有一份时说「留空就继续用它，
填了就替换」，否则说「存进系统钥匙串，不写进配置文件」。没有这句，编辑连接
的人会以为那一格空着就是没口令。

按本仓库的规矩，**改完要真的渲染出来看**，中英文与深浅色四种组合都要看：
指纹与 known_hosts 行号这类内容容易溢出或被截断，而这类缺陷单测抓不到。
