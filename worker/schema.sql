-- Users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT NOT NULL,
  token_expiry  INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Feedback on cards (preference learning)
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  sender      TEXT,
  subject     TEXT,
  category    TEXT,
  liked       INTEGER NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Sender routing rules
CREATE TABLE IF NOT EXISTS routing_rules (
  user_id       TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  destination   TEXT NOT NULL,
  drive_folder_id   TEXT,
  drive_folder_name TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, sender_domain)
);

-- Drive storage rules by category
CREATE TABLE IF NOT EXISTS storage_rules (
  user_id           TEXT NOT NULL,
  category          TEXT NOT NULL,
  drive_folder_id   TEXT NOT NULL,
  drive_folder_name TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);

-- Price history
CREATE TABLE IF NOT EXISTS price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price        REAL,
  currency     TEXT DEFAULT 'ILS',
  sender       TEXT,
  message_id   TEXT,
  seen_at      TEXT DEFAULT (datetime('now'))
);

-- Daily digest cache
CREATE TABLE IF NOT EXISTS digest_cache (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

-- Sender mutes
CREATE TABLE IF NOT EXISTS mutes (
  user_id     TEXT NOT NULL,
  sender      TEXT NOT NULL,
  mute_type   TEXT NOT NULL,
  category    TEXT,
  until       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, sender, mute_type)
);
