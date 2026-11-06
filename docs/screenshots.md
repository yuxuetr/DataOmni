# README 截图清单（U1）

`README.en.md` 里给截图留了位置（HTML 注释 `<!-- screenshot: … -->`，图还没有时什么也不显示）。
截好一张，放进 `images/en/`，把对应的注释换成下面「替换成」那一行。中文 README 以后要换图时同一套流程，放 `images/zh/`。

## 准备

- **打包版** v1.0.0 或更新（不要开发构建：标题栏、图标与菜单和发布版不一样）。顺带看一眼 rc.2 之后那批上色改动
  （Redis 值的 pickle / JSON 解码上色、控制台与预览上色），有问题记进 TODOs。
- **界面语言 English**（侧边栏底部切换），**浅色主题**，默认密度、默认字号。
- **示例数据**：`scripts/screenshot-sample-db.sh` 生成 `~/DataOmni-sample/shop.db`（SQLite，数据全是编的）。
  在应用里新建 SQLite 连接，名字写 `shop (sample)`，环境选 Development。
  MongoDB / Redis 那两张用本机 Docker 起的空库，连接名写 `local`，主机写 `localhost`。
- **不露真实信息**：连接列表里只留示例连接（可以换一个 bundle id 或临时 HOME 起一份副本，做法见 TODOs 5.1 那条
  「启动页的连接列表每行都能直接编辑」）；标题栏、标签页、历史里不要有真实主机名、库名、用户名。
- **窗口** 1440 × 900（逻辑像素）；macOS 上 ⇧⌘4 再按空格点窗口，或 `screencapture -o -l <窗口号>` 去掉阴影。
- **大小**：PNG，单张最好不超过 1 MB（`pngquant --quality 70-90` 或 `sips -Z 2400` 压一下）。

## 清单

| 文件 | 画面 | 放在 README.en.md 的 | 替换成 |
| --- | --- | --- | --- |
| `images/en/overview.png` | 左侧对象树展开 `shop (sample)` 的表；右边一个查询标签，上面是 `SELECT * FROM order_totals ORDER BY total DESC`，下面是结果网格 | 开头（替换旧的 `images/dataomni.png`） | `![DataOmni](images/en/overview.png)` |
| `images/en/query.png` | 编辑器里两条语句、光标停在第二条上；结果区上面是第一条的结果、下面切到图表（按 `status` 分组的 `count(*)` 柱状图） | Queries 一节末尾 | `![SQL editor with results and a chart](images/en/query.png)` |
| `images/en/table-edit.png` | `products` 表数据页：改了两格、删了一行（排着队还没提交），点开「预览 SQL」显示将要执行的三条语句 | Browsing and editing data 一节末尾 | `![Queued edits previewed as SQL](images/en/table-edit.png)` |
| `images/en/er-diagram.png` | `shop (sample)` 的 ER 图，五张表与外键连线都在画面里 | Browsing and editing data 一节末尾，紧跟 table-edit 那张 | `![ER diagram](images/en/er-diagram.png)` |
| `images/en/mongodb.png` | MongoDB 工作区：一个集合的文档列表，筛选框里写着一个条件，右边打开一篇文档 | MongoDB, Redis, Neo4j and Elasticsearch 一节末尾 | `![MongoDB workspace](images/en/mongodb.png)` |
| `images/en/redis.png` | Redis 工作区：按模式翻键，选中一个 hash 键看值 | 同上，紧跟 mongodb 那张 | `![Redis workspace](images/en/redis.png)` |

截完六张后：

1. 删掉 `images/dataomni.png`（4 MB 的旧图，界面早已不是那样）前，确认中文 README 也换了图或改指新图。
2. 在 `TODOs.md` 的 U1 下记一笔：哪个版本的包、哪台机器截的，顺带看到的上色问题。
