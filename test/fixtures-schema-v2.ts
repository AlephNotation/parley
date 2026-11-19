/** The schema as it was at version 2, kept so the upgrade from it stays tested. */
export const SCHEMA_V2 = `
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      agent_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sides (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      name TEXT NOT NULL,
      approval INTEGER NOT NULL DEFAULT 1,
      notify_url TEXT,
      notified_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mailboxes (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      last_seen INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      side_id TEXT NOT NULL REFERENCES sides(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE,
      mailbox_id TEXT REFERENCES mailboxes(id),
      revoked INTEGER NOT NULL DEFAULT 0,
      read_seq INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (mailbox_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      side_id TEXT NOT NULL REFERENCES sides(id),
      name TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES participants(id),
      redeemed_at INTEGER,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      participant_id TEXT REFERENCES participants(id),
      side_id TEXT REFERENCES sides(id),
      side_name TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'pending', 'rejected')),
      seq INTEGER,
      visible_to TEXT REFERENCES sides(id),
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_thread_seq ON messages (thread_id, seq);
    CREATE INDEX IF NOT EXISTS participants_mailbox ON participants (mailbox_id);
    PRAGMA user_version = 2;
`;
