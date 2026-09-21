-- DataOmni 示例 schema：一套专门用来观察 ER 关系图的表。
--
-- 这套结构刻意覆盖了几种在图上长得不一样的情况：
--   * 一条链：customers → orders → order_items
--   * 一个分叉：order_items 同时指向 orders 和 products
--   * 自引用：categories.parent_id → categories.id（图上是一个回到自己的框）
--   * 复合外键：inventory (warehouse_code, product_id) → warehouses / products
--   * 孤立的表：audit_log、schema_migrations、feature_flags——它们一条外键
--     都没有，正是用来确认「没有关联的表也画出来」这件事
--
-- MySQL 方言。PostgreSQL 版本见 sample-schema.postgres.sql。
-- 用法（MySQL）：
--   mysql -h HOST -u USER -p < examples/sample-schema.sql

CREATE DATABASE IF NOT EXISTS dataomni_demo
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;
USE dataomni_demo;

-- 先按依赖的反序删，重复执行这个脚本才不会被外键挡住
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS regions;
DROP TABLE IF EXISTS warehouses;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS schema_migrations;
DROP TABLE IF EXISTS feature_flags;

CREATE TABLE regions (
  id          INT NOT NULL AUTO_INCREMENT,
  code        VARCHAR(8) NOT NULL,
  name        VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_regions_code (code)
);

CREATE TABLE customers (
  id          INT NOT NULL AUTO_INCREMENT,
  region_id   INT NULL,
  name        VARCHAR(64) NOT NULL,
  email       VARCHAR(128) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email),
  CONSTRAINT fk_customers_region FOREIGN KEY (region_id)
    REFERENCES regions (id) ON DELETE SET NULL
);

-- 自引用：图上会画出一条从 parent_id 绕回 id 的线
CREATE TABLE categories (
  id          INT NOT NULL AUTO_INCREMENT,
  parent_id   INT NULL,
  name        VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id)
    REFERENCES categories (id) ON DELETE CASCADE
);

CREATE TABLE products (
  id          INT NOT NULL AUTO_INCREMENT,
  category_id INT NULL,
  sku         VARCHAR(32) NOT NULL,
  name        VARCHAR(128) NOT NULL,
  price       DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id)
    REFERENCES categories (id) ON DELETE SET NULL
);

CREATE TABLE orders (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  customer_id   INT NOT NULL,
  status        ENUM('draft', 'paid', 'shipped', 'cancelled') NOT NULL DEFAULT 'draft',
  total         DECIMAL(20, 4) NOT NULL DEFAULT 0.0000,
  placed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT
);

-- 分叉：同时指向 orders 与 products
CREATE TABLE order_items (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  order_id    BIGINT NOT NULL,
  product_id  INT NOT NULL,
  quantity    INT NOT NULL DEFAULT 1,
  unit_price  DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id)
    REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT ck_order_items_quantity CHECK (quantity > 0)
);

CREATE TABLE warehouses (
  code        VARCHAR(8) NOT NULL,
  region_id   INT NULL,
  name        VARCHAR(64) NOT NULL,
  PRIMARY KEY (code),
  CONSTRAINT fk_warehouses_region FOREIGN KEY (region_id)
    REFERENCES regions (id) ON DELETE SET NULL
);

-- 复合主键 + 两条外键，其中一条的列顺序与声明顺序不同，
-- 正好用来看连线有没有接错列
CREATE TABLE inventory (
  product_id      INT NOT NULL,
  warehouse_code  VARCHAR(8) NOT NULL,
  quantity        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_code, product_id),
  CONSTRAINT fk_inventory_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_warehouse FOREIGN KEY (warehouse_code)
    REFERENCES warehouses (code) ON DELETE CASCADE
);

-- 下面三张一条外键都没有：图上应当照常出现，排在有关联的分组下面
CREATE TABLE audit_log (
  id        BIGINT NOT NULL AUTO_INCREMENT,
  actor     VARCHAR(64) NULL,
  action    VARCHAR(64) NOT NULL,
  payload   JSON NULL,
  logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE schema_migrations (
  version   VARCHAR(32) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
);

CREATE TABLE feature_flags (
  name      VARCHAR(64) NOT NULL,
  enabled   TINYINT(1) NOT NULL DEFAULT 0,
  note      TEXT NULL,
  PRIMARY KEY (name)
);

-- 一点数据，方便顺手看表格视图
INSERT INTO regions (code, name) VALUES ('cn-east', '华东'), ('cn-north', '华北');
INSERT INTO categories (parent_id, name) VALUES (NULL, '全部');
INSERT INTO categories (parent_id, name) VALUES (1, '电子'), (1, '家居');
INSERT INTO customers (region_id, name, email) VALUES
  (1, '张伟', 'zhangwei@example.com'),
  (2, 'Ada Lovelace', 'ada@example.com');
INSERT INTO products (category_id, sku, name, price) VALUES
  (2, 'SKU-1001', '机械键盘', 499.00),
  (3, 'SKU-2001', '台灯', 129.50);
INSERT INTO warehouses (code, region_id, name) VALUES ('WH-E1', 1, '华东一仓');
INSERT INTO inventory (product_id, warehouse_code, quantity) VALUES (1, 'WH-E1', 25);
INSERT INTO orders (customer_id, status, total) VALUES (1, 'paid', 499.0000);
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (1, 1, 1, 499.00);
INSERT INTO schema_migrations (version) VALUES ('20260101_init');
INSERT INTO feature_flags (name, enabled, note) VALUES ('er_diagram', 1, '关系图');
