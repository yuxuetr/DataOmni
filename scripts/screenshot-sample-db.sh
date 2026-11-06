#!/usr/bin/env bash
# 截图用的示例库（TODOs「1.x」U1，清单见 docs/screenshots.md）：一个 SQLite 文件，数据全是编的，
# 截图里不会露出真实的主机名、库名和数据。有外键，ER 图有线可画；有 JSON、日期、NULL，网格上各种值都看得到。
#
#   scripts/screenshot-sample-db.sh [输出路径]     # 默认 ~/DataOmni-sample/shop.db
set -euo pipefail

out="${1:-$HOME/DataOmni-sample/shop.db}"
if [[ -e "$out" ]]; then
  echo "$out already exists; remove it first or pass another path" >&2
  exit 1
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed" >&2; exit 1; }
mkdir -p "$(dirname "$out")"

sqlite3 "$out" <<'SQL'
PRAGMA foreign_keys = ON;

CREATE TABLE customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL UNIQUE,
  country    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  parent INTEGER REFERENCES categories(id)
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  sku         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  price       NUMERIC NOT NULL CHECK (price >= 0),
  attributes  TEXT,               -- JSON
  discontinued INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status      TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  ordered_at  TEXT    NOT NULL,
  shipped_at  TEXT,
  note        TEXT
);

CREATE TABLE order_items (
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX orders_by_customer ON orders(customer_id, ordered_at);
CREATE VIEW order_totals AS
  SELECT o.id AS order_id, c.name AS customer, o.status, o.ordered_at,
         SUM(i.quantity * i.unit_price) AS total
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN order_items i ON i.order_id = o.id
  GROUP BY o.id;

INSERT INTO categories (id, name, parent) VALUES
  (1, 'Office', NULL), (2, 'Desks', 1), (3, 'Chairs', 1), (4, 'Lighting', NULL), (5, 'Accessories', NULL);

INSERT INTO customers (id, name, email, country, created_at) VALUES
  (1,  'Ada Lindqvist',   'ada@example.com',     'Sweden',      '2025-01-14 09:12:00'),
  (2,  'Bruno Costa',     'bruno@example.com',   'Portugal',    '2025-02-03 17:45:00'),
  (3,  'Chen Wei',        'chen.wei@example.com','China',       '2025-02-21 08:30:00'),
  (4,  'Dalia Haddad',    'dalia@example.com',   'Jordan',      '2025-03-09 12:05:00'),
  (5,  'Emeka Obi',       'emeka@example.com',   'Nigeria',     '2025-03-30 15:20:00'),
  (6,  'Freya Murphy',    'freya@example.com',   'Ireland',     '2025-04-11 10:00:00'),
  (7,  'Goro Tanaka',     'goro@example.com',    'Japan',       '2025-05-02 22:40:00'),
  (8,  'Hana Novak',      'hana@example.com',    'Czechia',     '2025-05-18 07:55:00'),
  (9,  'Ivan Petrov',     'ivan@example.com',    'Bulgaria',    '2025-06-06 13:10:00'),
  (10, 'Julia Romero',    'julia@example.com',   'Argentina',   '2025-06-27 19:35:00');

INSERT INTO products (id, category_id, sku, name, price, attributes, discontinued) VALUES
  (1, 2, 'DSK-140', 'Standing desk 140 cm',  489.00, '{"width_cm":140,"motor":"dual","colors":["oak","white"]}', 0),
  (2, 2, 'DSK-120', 'Standing desk 120 cm',  429.00, '{"width_cm":120,"motor":"single","colors":["white"]}',     0),
  (3, 3, 'CHR-ERG', 'Ergonomic chair',       319.50, '{"lumbar":true,"armrests":"4D"}',                          0),
  (4, 3, 'CHR-STL', 'Stool',                  89.90, NULL,                                                       1),
  (5, 4, 'LMP-LED', 'LED desk lamp',          59.00, '{"lumens":800,"dimmable":true}',                           0),
  (6, 5, 'ACC-MAT', 'Desk mat',               24.00, '{"size":"90x40"}',                                         0),
  (7, 5, 'ACC-ARM', 'Monitor arm',            74.00, '{"max_kg":9}',                                             0),
  (8, 5, 'ACC-CBL', 'Cable tray',             19.50, NULL,                                                       0);

-- 120 张订单，日期、状态、条数按 id 算出来，每次生成的都一样
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
INSERT INTO orders (id, customer_id, status, ordered_at, shipped_at, note)
SELECT i,
       (i * 7) % 10 + 1,
       CASE WHEN i % 11 = 0 THEN 'cancelled' WHEN i % 5 = 0 THEN 'pending' WHEN i % 3 = 0 THEN 'paid' ELSE 'shipped' END,
       datetime('2025-07-01', '+' || (i * 2) || ' days', '+' || (i * 37 % 600) || ' minutes'),
       CASE WHEN i % 11 <> 0 AND i % 5 <> 0 AND i % 3 <> 0
            THEN datetime('2025-07-01', '+' || (i * 2 + 2) || ' days') END,
       CASE WHEN i % 17 = 0 THEN 'Leave at the front desk' END
FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT i, p.id, (i + p.id) % 3 + 1, p.price
FROM n JOIN products p ON p.id IN ((i % 8) + 1, ((i * 3) % 8) + 1)
GROUP BY i, p.id;
SQL

echo "wrote $out"
sqlite3 "$out" "SELECT 'orders', count(*) FROM orders UNION ALL SELECT 'order_items', count(*) FROM order_items;"
