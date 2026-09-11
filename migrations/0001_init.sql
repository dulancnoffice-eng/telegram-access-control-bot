PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  chat_type TEXT NOT NULL DEFAULT 'supergroup',
  authorized INTEGER NOT NULL DEFAULT 0,
  auto_restrict_new_members INTEGER NOT NULL DEFAULT 1,
  strict_enforcement INTEGER NOT NULL DEFAULT 1,
  delete_join_messages INTEGER NOT NULL DEFAULT 1,
  delete_controller_commands INTEGER NOT NULL DEFAULT 1,
  authorized_by INTEGER,
  authorized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controllers (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_controllers (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  added_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS known_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  is_bot INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS allowed_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  allowed_by INTEGER,
  allowed_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_user_id INTEGER,
  group_id INTEGER,
  target_user_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  claimed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_authorized ON groups (authorized);
CREATE INDEX IF NOT EXISTS idx_group_controllers_user ON group_controllers (user_id, group_id);
CREATE INDEX IF NOT EXISTS idx_known_members_group_seen ON known_members (group_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_known_members_username ON known_members (group_id, username);
CREATE INDEX IF NOT EXISTS idx_allowed_members_group ON allowed_members (group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_audit_group_created ON audit_logs (group_id, created_at DESC);
