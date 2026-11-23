import { Database } from "bun:sqlite";

export type ParticipantKind = "human" | "agent";
export type MessageKind = ParticipantKind | "system";
export type MessageStatus = "sent" | "pending" | "rejected";
/** Who a message is meant to wake: named agents or sides, the whole room, or nobody. */
export type Audience = "direct" | "room" | "fyi";

/** Bump when the schema changes, and add the step from the previous version to MIGRATIONS. */
const SCHEMA_VERSION = 6;

/** MIGRATIONS[n] upgrades a database from schema version n to n + 1. */
const MIGRATIONS: Record<number, string> = {
  2: `
    ALTER TABLE messages ADD COLUMN audience TEXT NOT NULL DEFAULT 'room';
    ALTER TABLE messages ADD COLUMN addressed TEXT;
    ALTER TABLE participants ADD COLUMN tokens REAL NOT NULL DEFAULT 3;
    ALTER TABLE participants ADD COLUMN tokens_at INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE wakes (
      message_id INTEGER NOT NULL REFERENCES messages(id),
      participant_id TEXT NOT NULL REFERENCES participants(id),
      wake_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, participant_id)
    );
    CREATE INDEX wakes_participant ON wakes (participant_id, wake_at);
    -- Before this version every message woke every agent, so mail still unread keeps doing so.
    INSERT INTO wakes (message_id, participant_id, wake_at)
      SELECT m.id, p.id, 0 FROM messages m JOIN participants p ON p.thread_id = m.thread_id
      WHERE p.kind = 'agent' AND m.status = 'sent' AND m.seq > p.read_seq
        AND m.participant_id IS NOT p.id AND (m.visible_to IS NULL OR m.visible_to = p.side_id);
  `,
  3: `
    ALTER TABLE threads ADD COLUMN archived_at INTEGER;
    ALTER TABLE threads ADD COLUMN archived_by TEXT;
  `,
  4: `
    ALTER TABLE mailboxes ADD COLUMN wake_url TEXT;
    ALTER TABLE mailboxes ADD COLUMN woken_message_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mailboxes ADD COLUMN woken_at INTEGER NOT NULL DEFAULT 0;
  `,
  5: `
    -- For agents: 1 when a session on its machine attends the room, 0 when none does, NULL when
    -- its client has never said (older clients, which tell every session).
    ALTER TABLE participants ADD COLUMN attended INTEGER;
  `,
};

export interface ThreadRow {
  id: string;
  title: string;
  paused: number;
  version: number;
  agent_streak: number;
  created_at: number;
  /** When a human archived the room, making it read-only. Null while it is open. */
  archived_at: number | null;
  /** Who archived it. */
  archived_by: string | null;
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
  /** Webhook called when mail should wake this agent and no session of it is listening. */
  wake_url: string | null;
  /** Newest message the wake webhook was already called for, so each piece of mail calls it once. */
  woken_message_id: number;
  /** When the wake webhook was last called. */
  woken_at: number;
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
  /** Attention budget: wake tokens left as of `tokens_at`. A `tokens_at` in the future is a wake already being held until then. */
  tokens: number;
  tokens_at: number;
  last_seen: number | null;
  /** Agents only: 1 a session attends this room, 0 none does, null the client never said. */
  attended: number | null;
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
  audience: Audience;
  /** JSON array of the agent or side names the sender addressed, as written. Null when none. */
  addressed: string | null;
  created_at: number;
  delivered_at: number | null;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const { user_version: found } = db.query("PRAGMA user_version").get() as { user_version: number };
  const hasTables = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() !== null;
  if (hasTables && found !== SCHEMA_VERSION) {
    const steps: string[] = [];
    for (let v = found; v < SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      if (!step) break;
      steps.push(step);
    }
    if (found > SCHEMA_VERSION || steps.length !== SCHEMA_VERSION - found) {
      db.close();
      throw new Error(
        `The database at ${path} uses schema version ${found}, but this build needs version ${SCHEMA_VERSION} ` +
          "and has no migration between them: move the file aside (or set PARLEY_DB to a new path) and start again.",
      );
    }
    // All steps or none: a failed upgrade leaves the file exactly as it was.
    db.transaction(() => {
      for (const step of steps) db.exec(step);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
    console.log(`Upgraded the database at ${path} from schema version ${found} to ${SCHEMA_VERSION}.`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      agent_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      archived_by TEXT
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
      created_at INTEGER NOT NULL,
      wake_url TEXT,
      woken_message_id INTEGER NOT NULL DEFAULT 0,
      woken_at INTEGER NOT NULL DEFAULT 0
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
      tokens REAL NOT NULL DEFAULT 3,
      tokens_at INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      attended INTEGER,
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
      delivered_at INTEGER,
      audience TEXT NOT NULL DEFAULT 'room',
      addressed TEXT
    );
    CREATE TABLE IF NOT EXISTS wakes (
      message_id INTEGER NOT NULL REFERENCES messages(id),
      participant_id TEXT NOT NULL REFERENCES participants(id),
      wake_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, participant_id)
    );
    CREATE INDEX IF NOT EXISTS wakes_participant ON wakes (participant_id, wake_at);
    CREATE INDEX IF NOT EXISTS messages_thread_seq ON messages (thread_id, seq);
    CREATE INDEX IF NOT EXISTS participants_mailbox ON participants (mailbox_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  return db;
}
