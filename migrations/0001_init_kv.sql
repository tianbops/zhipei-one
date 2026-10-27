-- 智配One · D1 数据库初始化（Upstash Redis 替代层）
-- ------------------------------------------------------------------
-- 单张泛化 kv 表，承载 string / hash / set / list 四种 Redis 数据结构。
-- 值统一以 JSON 文本存储，type 区分结构；expires_at 为 Unix 秒，NULL 表示永不过期。
--
-- 执行方式（二选一）：
--   1) 线上（Cloudflare D1）：
--        npx wrangler d1 execute zhipei-one --file=migrations/0001_init_kv.sql --remote
--   2) 本地（wrangler pages dev 或 d1 本地）：
--        npx wrangler d1 execute zhipei-one --file=migrations/0001_init_kv.sql --local
--
-- 本脚本幂等（IF NOT EXISTS），可重复执行。

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  type        TEXT    NOT NULL,            -- 'string' | 'hash' | 'set' | 'list'
  expires_at  INTEGER                     -- Unix 秒；NULL = 永不过期
);

-- 过期键清理游标（仅对带 TTL 的行生效，partial index 让扫描更轻）。
CREATE INDEX IF NOT EXISTS idx_kv_expires
  ON kv (expires_at)
  WHERE expires_at IS NOT NULL;

-- SCAN / 前缀遍历依赖 key 上的 LIKE。主键即 key，前缀模式（如 'zp:%'）可直接走主键索引；
-- 非前缀模式（如 '%:x'）走全表扫描，本项目实际 SCAN 均为前缀模式，可接受。
-- 如需覆盖更多模式可额外建 idx_kv_key，但当前无需。
