import { Database } from "bun:sqlite";

export type ParticipantKind = "human" | "agent";
export type MessageKind = ParticipantKind | "system";
export type MessageStatus = "sent" | "pending" | "rejected";

/** Bump when the schema changes incompatibly. */
const SCHEMA_VERSION = 2;

export interface ThreadRow {
  id: string;
  title: string;
  paused: number;
  version: number;
  agent_streak: number;
  created_at: number;
}

export interface SideRow {
  id: string;
  thread_id: string;
  name: string;
  approval: number;
  /** Webhook called when mail for this side's agents sits unread. */
  notify_url: string | null;
  /** Highest message seq this side's humans were already notified about. */
  notified_seq: number;
}

/** An agent's durable identity: one address and one inbox across every thread it joins. */
export interface MailboxRow {
  id: string;
  address: string;
  label: string;
  token_hash: string;
  last_seen: number | null;
  created_at: number;
}

/** A seat in one thread. Humans hold a link token; agents are seated through their mailbox. */
export interface ParticipantRow {
  id: string;
  thread_id: string;
  side_id: string;
  kind: ParticipantKind;
  name: string;
  token_hash: string | null;
  mailbox_id: string | null;
  revoked: number;
  /** Highest seq this participant has acknowledged. Everything after it is unread. */
  read_seq: number;
  last_seen: number | null;
  created_at: number;
}

export interface InviteRow {
  id: string;
  code_hash: string;
  thread_id: string;
  side_id: string;
  name: string;
  created_by: string;
  redeemed_at: number | null;
  expires_at: number;
  created_at: number;
}

export interface MessageRow {
  id: number;
  thread_id: string;
  participant_id: string | null;
  side_id: string | null;
  side_name: string | null;
  kind: MessageKind;
  author: string;
  body: string;
  status: MessageStatus;
  /** Delivery order within the thread. Null until the message is delivered. */
  seq: number | null;
  /** When set, only this side can see the message. */
  visible_to: string | null;
  created_at: number;
  delivered_at: number | null;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const { user_version: found } = db.query("PRAGMA user_version").get() as { user_version: number };
  const hasTables = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() !== null;
  if (hasTables && found !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `The database at ${path} uses schema version ${found}, but this build needs version ${SCHEMA_VERSION}. ` +
        "There is no migration yet: move the file aside (or set PARLEY_DB to a new path) and start again.",
    );
  }

  db.exec(`
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
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  return db;
}
