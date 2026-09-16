-- Global master allowlist.
-- The BOT_OWNER_ID can replace this list by sending plain Telegram user IDs
-- privately to the bot, one ID per line.

CREATE TABLE IF NOT EXISTS global_allowed_members (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_allowed_members_added_at
  ON global_allowed_members (added_at);
