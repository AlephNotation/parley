import { randomBytes, timingSafeEqual } from "node:crypto";
import { agentInstructions, inviteTexts } from "./agent-instructions";
import {
  openDb,
  type InviteRow,
  type MailboxRow,
  type MessageKind,
  type MessageRow,
  type ParticipantKind,
  type ParticipantRow,
  type SideRow,
  type ThreadRow,
} from "./db";
import { clientDownload, installScript } from "./install";
import { homePage, invitePage, threadPage } from "./ui";

export interface AppOptions {
  /** SQLite path. Defaults to an in-memory database. */
  dbPath?: string;
  /** Bearer token that can always create rooms. */
  adminToken: string;
  /** Let anyone who can reach the server create rooms, agents included. Defaults to true. */
  openRooms?: boolean;
  /** Externally visible origin, e.g. https://parley.example.com. Derived from the request when unset. */
  publicUrl?: string;
  /** Consecutive unreviewed agent messages before the thread pauses itself. */
  streakLimit?: number;
  /** Upper bound for long-poll waits, in seconds. Must stay below the server's idle timeout. */
  maxWaitSeconds?: number;
  /** Directory holding compiled `parley-<os>-<arch>` client binaries. */
  distDir?: string;
  /** How long mail may sit unread before the side's humans are told. */
  notifyDelayMs?: number;
  /** How often to look for unread mail to notify about. 0 disables the sweeper. */
  sweepIntervalMs?: number;
  /** Allow notification webhooks to plain-http and private hosts. For local development and tests only. */
  allowPrivateWebhooks?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
/** A client between two long-polls still counts as listening for this long. */
const LISTEN_GRACE_MS = 15_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOX_PAGE = 50;

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: noStore });
}

function html(body: string): Response {
  return new Response(body, { headers: { ...noStore, "content-type": "text/html; charset=utf-8" } });
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const newId = () => randomBytes(8).toString("hex");
const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HttpError(400, "bad_parameter", `Query parameter "${name}" must be an integer, got "${raw}".`);
  }
  return value;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

export function createApp(opts: AppOptions) {
  const db = openDb(opts.dbPath ?? ":memory:");
  const streakLimit = opts.streakLimit ?? 30;
  const maxWait = opts.maxWaitSeconds ?? 240;
  const notifyDelayMs = opts.notifyDelayMs ?? 120_000;
  const waiters = new Map<string, Set<() => void>>();
  /** Open long-polls per participant, used to report who is listening. */
  const polls = new Map<string, { open: number; endedAt: number }>();

  // ---- long-poll plumbing -------------------------------------------------

  function wake(key: string) {
    for (const fn of [...(waiters.get(key) ?? [])]) fn();
  }

  /** Re-runs `check` each time one of `keys` is woken, until it returns non-null or the wait expires. */
  async function waitFor<T>(keys: string[], waitSeconds: number, signal: AbortSignal, check: () => T | null): Promise<T | null> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const result = check();
      if (result !== null) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          for (const key of keys) {
            const set = waiters.get(key);
            set?.delete(done);
            if (set?.size === 0) waiters.delete(key);
          }
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        for (const key of keys) {
          let set = waiters.get(key);
          if (!set) waiters.set(key, (set = new Set()));
          set.add(done);
        }
        signal.addEventListener("abort", done);
      });
    }
  }

  async function listeningWhile<T>(participantIds: string[], fn: () => Promise<T>): Promise<T> {
    const entries = participantIds.map((id) => {
      let entry = polls.get(id);
      if (!entry) polls.set(id, (entry = { open: 0, endedAt: 0 }));
      entry.open++;
      return entry;
    });
    try {
      return await fn();
    } finally {
      for (const entry of entries) {
        entry.open--;
        entry.endedAt = Date.now();
      }
    }
  }

  // ---- data helpers -------------------------------------------------------

  const getThread = (id: string) => db.query("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow;
  const getSide = (id: string) => db.query("SELECT * FROM sides WHERE id = ?").get(id) as SideRow;
  const getSides = (threadId: string) => db.query("SELECT * FROM sides WHERE thread_id = ? ORDER BY rowid").all(threadId) as SideRow[];

  /** Marks the thread changed and wakes everyone waiting on it: open pages and every member mailbox. */
  function bump(threadId: string) {
    db.query("UPDATE threads SET version = version + 1 WHERE id = ?").run(threadId);
    wake(`t:${threadId}`);
    const rows = db
      .query("SELECT DISTINCT mailbox_id FROM participants WHERE thread_id = ? AND mailbox_id IS NOT NULL AND revoked = 0")
      .all(threadId) as { mailbox_id: string }[];
    for (const row of rows) wake(`m:${row.mailbox_id}`);
  }

  const touch = (participantId: string) => db.query("UPDATE participants SET last_seen = ? WHERE id = ?").run(Date.now(), participantId);

  function maxSeq(threadId: string): number {
    return (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE thread_id = ?").get(threadId) as { seq: number }).seq;
  }

  function insertMessage(m: {
    threadId: string;
    participant?: ParticipantRow;
    kind: MessageKind;
    author: string;
    body: string;
    deliver: boolean;
    visibleTo?: string;
  }): MessageRow {
    const side = m.participant ? getSide(m.participant.side_id) : null;
    const now = Date.now();
    return db
      .query(
        `INSERT INTO messages (thread_id, participant_id, side_id, side_name, kind, author, body, status, seq, visible_to, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        m.threadId,
        m.participant?.id ?? null,
        side?.id ?? null,
        side?.name ?? null,
        m.kind,
        m.author,
        m.body,
        m.deliver ? "sent" : "pending",
        m.deliver ? maxSeq(m.threadId) + 1 : null,
        m.visibleTo ?? null,
        now,
        m.deliver ? now : null,
      ) as MessageRow;
  }

  function systemMessage(threadId: string, body: string, visibleTo?: string) {
    insertMessage({ threadId, kind: "system", author: "Parley", body, deliver: true, visibleTo });
  }

  const view = (m: MessageRow) => ({
    id: m.id,
    seq: m.seq,
    from: m.author,
    side: m.side_name,
    kind: m.kind,
    body: m.body,
    at: new Date(m.created_at).toISOString(),
  });

  function visibleMessages(p: ParticipantRow, after: number, limit = 1000): MessageRow[] {
    return db
      .query(
        `SELECT * FROM messages
         WHERE thread_id = ? AND status = 'sent' AND seq > ? AND (visible_to IS NULL OR visible_to = ?)
         ORDER BY seq LIMIT ?`,
      )
      .all(p.thread_id, after, p.side_id, limit) as MessageRow[];
  }

  /** Mail for a participant: delivered, visible to its side, after its read mark, and not written by it. */
  function unreadFor(p: ParticipantRow, limit: number, floor = 0): MessageRow[] {
    return db
      .query(
        `SELECT * FROM messages
         WHERE thread_id = ? AND status = 'sent' AND seq > ? AND (visible_to IS NULL OR visible_to = ?)
           AND participant_id IS NOT ?
         ORDER BY seq LIMIT ?`,
      )
      .all(p.thread_id, Math.max(p.read_seq, floor), p.side_id, p.id, limit) as MessageRow[];
  }

  /** Humans see everything their side has waiting for review; agents see only their own. */
  function pendingFor(p: ParticipantRow): MessageRow[] {
    const filter = p.kind === "human" ? "side_id = ?" : "participant_id = ?";
    return db
      .query(`SELECT * FROM messages WHERE thread_id = ? AND status = 'pending' AND ${filter} ORDER BY id`)
      .all(p.thread_id, p.kind === "human" ? p.side_id : p.id) as MessageRow[];
  }

  // ---- presence -----------------------------------------------------------

  type Presence = {
    name: string;
    side: string;
    kind: ParticipantKind;
    /** not_joined: never connected. listening: has a long-poll open. away: joined but not waiting. */
    state: "not_joined" | "listening" | "away";
    last_seen_seconds_ago: number | null;
    /** For agents: delivered messages it has not acknowledged yet. */
    unread: number | null;
    side_id: string;
  };

  function presence(threadId: string): Presence[] {
    const rows = db
      .query(
        `SELECT p.*, s.name AS side_name FROM participants p JOIN sides s ON s.id = p.side_id
         WHERE p.thread_id = ? AND p.revoked = 0 ORDER BY s.rowid, p.kind DESC, p.created_at`,
      )
      .all(threadId) as (ParticipantRow & { side_name: string })[];
    const now = Date.now();
    return rows.map((r) => {
      const poll = polls.get(r.id);
      const listening = !!poll && (poll.open > 0 || now - poll.endedAt < LISTEN_GRACE_MS);
      return {
        name: r.name,
        side: r.side_name,
        kind: r.kind,
        state: r.last_seen === null ? "not_joined" : listening ? "listening" : "away",
        last_seen_seconds_ago: r.last_seen === null ? null : Math.round((now - r.last_seen) / 1000),
        unread: r.kind === "agent" ? unreadFor(r, 1000).length : null,
        side_id: r.side_id,
      };
    });
  }

  const publicPresence = (threadId: string) => presence(threadId).map(({ side_id, ...rest }) => rest);

  /** Tells a poster whether anyone on the other side will actually be woken by the message. */
  function deliveryNote(p: ParticipantRow): string {
    const everyone = presence(p.thread_id);
    const parts = getSides(p.thread_id)
      .filter((s) => s.id !== p.side_id)
      .map((side) => {
        const agents = everyone.filter((x) => x.side_id === side.id && x.kind === "agent");
        if (agents.length === 0) return `No agent has joined on ${side.name} yet; only its humans will see this.`;
        return agents
          .map((a) =>
            a.state === "listening"
              ? `${a.name} is listening and will be notified now.`
              : `${a.name} is not listening right now (last active ${a.last_seen_seconds_ago}s ago); it will see this when it next checks.`,
          )
          .join(" ");
      });
    return `Delivered. ${parts.join(" ")}`;
  }

  // ---- auth ---------------------------------------------------------------

  function requireToken(req: Request): string {
    const token = bearer(req);
    if (!token) {
      throw new HttpError(401, "missing_token", "Missing Authorization header.", 'Send "Authorization: Bearer <token>".');
    }
    return token;
  }

  function authHuman(req: Request): ParticipantRow {
    const token = requireToken(req);
    if (token.startsWith("pm_")) {
      throw new HttpError(403, "wrong_role", "This action needs a human's room link; yours is an agent token.");
    }
    const p = db
      .query("SELECT * FROM participants WHERE token_hash = ? AND kind = 'human'")
      .get(sha256(token)) as ParticipantRow | null;
    if (!p) throw new HttpError(401, "invalid_token", "This token is not recognised.", "Open the full room link you were sent.");
    touch(p.id);
    return p;
  }

  function authMailbox(req: Request): MailboxRow {
    const token = requireToken(req);
    if (token.startsWith("ph_")) {
      throw new HttpError(403, "wrong_role", "This action needs an agent token; yours is a human's room link.");
    }
    const box = db.query("SELECT * FROM mailboxes WHERE token_hash = ?").get(sha256(token)) as MailboxRow | null;
    if (!box) {
      throw new HttpError(401, "invalid_token", "This agent token is not recognised.", "Run `parley join <room link>` again.");
    }
    db.query("UPDATE mailboxes SET last_seen = ? WHERE id = ?").run(Date.now(), box.id);
    return box;
  }

  /** The mailbox's seat in one thread. */
  function seat(box: MailboxRow, threadId: string): ParticipantRow {
    const p = db
      .query("SELECT * FROM participants WHERE mailbox_id = ? AND thread_id = ?")
      .get(box.id, threadId) as ParticipantRow | null;
    if (!p) {
      throw new HttpError(404, "not_a_member", `You are not in room ${threadId}.`, "GET /api/threads lists the rooms you are in.");
    }
    if (p.revoked) {
      throw new HttpError(403, "removed", "A human on your side removed you from this room.", "Stop using this room and tell your human.");
    }
    touch(p.id);
    return p;
  }

  function seats(box: MailboxRow, only?: string[]): ParticipantRow[] {
    const all = db
      .query("SELECT * FROM participants WHERE mailbox_id = ? AND revoked = 0 ORDER BY created_at")
      .all(box.id) as ParticipantRow[];
    return only ? all.filter((p) => only.includes(p.thread_id)) : all;
  }

  function requireAdmin(req: Request) {
    const token = bearer(req);
    if (!token || !safeEqual(token, opts.adminToken)) {
      throw new HttpError(
        401,
        "admin_required",
        "Creating a room requires the admin token on this server.",
        "Ask whoever runs the server to create the room, or to set PARLEY_OPEN_ROOMS=1.",
      );
    }
  }

  function baseUrl(req: Request): string {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const url = new URL(req.url);
    const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
    const host = req.headers.get("x-forwarded-host") ?? url.host;
    return `${proto}://${host}`;
  }

  // ---- threads and humans -------------------------------------------------

  async function createThread(req: Request): Promise<Response> {
    if (opts.openRooms === false) requireAdmin(req);
    const input = await readJson(req);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) throw new HttpError(400, "bad_title", '"title" must be a string of 1-200 characters.');
    if (!Array.isArray(input.sides) || input.sides.length < 2 || input.sides.length > 6) {
      throw new HttpError(400, "bad_sides", '"sides" must be an array of 2-6 entries, each a name or {name, approval}.');
    }
    const sides = input.sides.map((raw: unknown) => {
      const obj = typeof raw === "string" ? { name: raw } : (raw as { name?: unknown; approval?: unknown } | null);
      const name = typeof obj?.name === "string" ? obj.name.trim() : "";
      if (!name || name.length > 60) throw new HttpError(400, "bad_sides", "Each side needs a name of 1-60 characters.");
      // Agents chat freely unless a side asks for review.
      return { name, approval: obj?.approval === true ? 1 : 0 };
    });
    if (new Set(sides.map((s) => s.name.toLowerCase())).size !== sides.length) {
      throw new HttpError(400, "bad_sides", "Side names must be unique.");
    }

    const threadId = newId();
    const base = baseUrl(req);
    const out = db.transaction(() => {
      db.query("INSERT INTO threads (id, title, created_at) VALUES (?, ?, ?)").run(threadId, title, Date.now());
      const created = sides.map((side) => {
        const sideId = newId();
        const token = newToken("ph");
        db.query("INSERT INTO sides (id, thread_id, name, approval) VALUES (?, ?, ?, ?)").run(sideId, threadId, side.name, side.approval);
        db.query(
          "INSERT INTO participants (id, thread_id, side_id, kind, name, token_hash, created_at) VALUES (?, ?, ?, 'human', ?, ?, ?)",
        ).run(newId(), threadId, sideId, `${side.name} (human)`, sha256(token), Date.now());
        // The token lives in the URL fragment so it never reaches server logs.
        return { name: side.name, approval: side.approval === 1, human_url: `${base}/t#${token}` };
      });
      systemMessage(threadId, `Room "${title}" created for ${sides.map((s) => s.name).join(" and ")}.`);
      return created;
    })();
    return json({ thread: { id: threadId, title }, sides: out }, 201);
  }

  async function getState(req: Request, url: URL): Promise<Response> {
    const p = authHuman(req);
    const known = intParam(url, "v", -1);
    const wait = Math.min(maxWait, Math.max(0, intParam(url, "wait", 0)));
    const changed = () => (getThread(p.thread_id).version > known ? true : null);
    if (wait > 0) await listeningWhile([p.id], () => waitFor([`t:${p.thread_id}`], wait, req.signal, changed));
    const thread = getThread(p.thread_id);
    const mine = getSide(p.side_id);
    const agents = db
      .query(
        `SELECT p.id, p.name, m.address FROM participants p JOIN mailboxes m ON m.id = p.mailbox_id
         WHERE p.side_id = ? AND p.kind = 'agent' AND p.revoked = 0 ORDER BY p.created_at`,
      )
      .all(p.side_id) as { id: string; name: string; address: string }[];
    const openInvites = (
      db.query("SELECT COUNT(*) AS n FROM invites WHERE side_id = ? AND redeemed_at IS NULL AND expires_at > ?").get(p.side_id, Date.now()) as {
        n: number;
      }
    ).n;
    return json({
      version: thread.version,
      thread: { id: thread.id, title: thread.title, paused: thread.paused === 1 },
      you: { id: p.id, name: p.name, kind: p.kind, side: mine.name },
      sides: getSides(p.thread_id).map((s) => ({ name: s.name, approval: s.approval === 1, yours: s.id === p.side_id })),
      notify_url: mine.notify_url,
      agents,
      open_invites: openInvites,
      participants: publicPresence(p.thread_id),
      messages: visibleMessages(p, 0).map(view),
      pending: pendingFor(p).map(view),
    });
  }

  async function reviewMessage(req: Request, id: number, action: "approve" | "reject"): Promise<Response> {
    const p = authHuman(req);
    const input = await readJson(req);
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : "";
    db.transaction(() => {
      const message = db.query("SELECT * FROM messages WHERE id = ? AND thread_id = ?").get(id, p.thread_id) as MessageRow | null;
      if (!message || message.side_id !== p.side_id) throw new HttpError(404, "not_found", `No message ${id} awaiting review on your side.`);
      if (message.status !== "pending") throw new HttpError(409, "already_reviewed", `Message ${id} is already ${message.status}.`);
      if (action === "approve") {
        db.query("UPDATE messages SET status = 'sent', seq = ?, delivered_at = ? WHERE id = ?").run(maxSeq(p.thread_id) + 1, Date.now(), id);
        db.query("UPDATE threads SET agent_streak = 0 WHERE id = ?").run(p.thread_id);
      } else {
        db.query("UPDATE messages SET status = 'rejected' WHERE id = ?").run(id);
        systemMessage(
          p.thread_id,
          `${p.name} rejected message #${id} from ${message.author}; it was not sent to the other side.` + (note ? ` Note: ${note}` : ""),
          p.side_id,
        );
      }
    })();
    bump(p.thread_id);
    return json({ ok: true });
  }

  async function setPaused(req: Request): Promise<Response> {
    const p = authHuman(req);
    const input = await readJson(req);
    if (typeof input.paused !== "boolean") throw new HttpError(400, "bad_request", 'Body must be {"paused": true|false}.');
    const paused = input.paused;
    if ((getThread(p.thread_id).paused === 1) !== paused) {
      db.transaction(() => {
        db.query("UPDATE threads SET paused = ?, agent_streak = 0 WHERE id = ?").run(paused ? 1 : 0, p.thread_id);
        systemMessage(p.thread_id, paused ? `${p.name} paused the room. Agents cannot post until it is resumed.` : `${p.name} resumed the room.`);
      })();
      bump(p.thread_id);
    }
    return json({ paused });
  }

  function checkWebhook(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, "bad_notify_url", "notify_url is not a valid URL.");
    }
    if (opts.allowPrivateWebhooks) return url.toString();
    const host = url.hostname.toLowerCase();
    const isIp = /^\d+(\.\d+){3}$/.test(host) || host.includes(":");
    if (url.protocol !== "https:" || isIp || host === "localhost" || /\.(local|internal|localhost)$/.test(host)) {
      throw new HttpError(400, "bad_notify_url", "notify_url must be an https URL on a public hostname.");
    }
    return url.toString();
  }

  async function setSettings(req: Request): Promise<Response> {
    const p = authHuman(req);
    const input = await readJson(req);
    const side = getSide(p.side_id);
    let changed = false;
    if (input.approval !== undefined) {
      if (typeof input.approval !== "boolean") throw new HttpError(400, "bad_request", '"approval" must be true or false.');
      const approval = input.approval;
      if ((side.approval === 1) !== approval) {
        db.transaction(() => {
          db.query("UPDATE sides SET approval = ? WHERE id = ?").run(approval ? 1 : 0, side.id);
          systemMessage(
            p.thread_id,
            approval
              ? `${side.name} now reviews its agents' messages before they are sent.`
              : `${side.name} no longer reviews its agents' messages before they are sent.`,
          );
        })();
        changed = true;
      }
    }
    if (input.notify_url !== undefined) {
      if (input.notify_url !== null && typeof input.notify_url !== "string") {
        throw new HttpError(400, "bad_request", '"notify_url" must be a URL string or null.');
      }
      const value = input.notify_url ? checkWebhook(input.notify_url.trim()) : null;
      // Start from the present so turning notifications on does not replay old mail.
      db.query("UPDATE sides SET notify_url = ?, notified_seq = ? WHERE id = ?").run(value, maxSeq(p.thread_id), side.id);
      changed = true;
    }
    if (changed) bump(p.thread_id);
    const now = getSide(side.id);
    return json({ approval: now.approval === 1, notify_url: now.notify_url });
  }

  async function createInvite(req: Request): Promise<Response> {
    const p = authHuman(req);
    const input = await readJson(req);
    const side = getSide(p.side_id);
    const taken = (db.query("SELECT COUNT(*) AS n FROM participants WHERE side_id = ? AND kind = 'agent'").get(side.id) as { n: number }).n;
    const open = (db.query("SELECT COUNT(*) AS n FROM invites WHERE side_id = ? AND redeemed_at IS NULL").get(side.id) as { n: number }).n;
    const requested = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
    const name = requested || `${side.name} Claude${taken + open ? ` ${taken + open + 1}` : ""}`;
    const code = newToken("pi");
    const expires = Date.now() + INVITE_TTL_MS;
    db.query(
      "INSERT INTO invites (id, code_hash, thread_id, side_id, name, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(newId(), sha256(code), p.thread_id, side.id, name, p.id, expires, Date.now());
    bump(p.thread_id);
    return json({ name, code, expires_at: new Date(expires).toISOString(), ...inviteTexts(baseUrl(req), code) }, 201);
  }

  function revokeAgent(req: Request, id: string): Response {
    const p = authHuman(req);
    const agent = db.query("SELECT * FROM participants WHERE id = ? AND side_id = ? AND kind = 'agent'").get(id, p.side_id) as ParticipantRow | null;
    if (!agent) throw new HttpError(404, "not_found", "No such agent on your side.");
    if (!agent.revoked) {
      db.transaction(() => {
        db.query("UPDATE participants SET revoked = 1 WHERE id = ?").run(id);
        db.query("UPDATE messages SET status = 'rejected' WHERE participant_id = ? AND status = 'pending'").run(id);
        systemMessage(p.thread_id, `${p.name} removed ${agent.name} from the room.`);
      })();
      bump(p.thread_id);
      if (agent.mailbox_id) wake(`m:${agent.mailbox_id}`);
    }
    return json({ ok: true });
  }

  // ---- posting ------------------------------------------------------------

  async function readMessageBody(req: Request): Promise<string> {
    const raw = await req.text();
    let body = raw;
    if ((req.headers.get("content-type") ?? "").includes("json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "bad_json", "Body is not valid JSON.", 'Send JSON {"body": "..."}, or plain text with Content-Type: text/plain.');
      }
      const value = (parsed as { body?: unknown } | null)?.body;
      if (typeof value !== "string") throw new HttpError(400, "bad_message", 'JSON body must look like {"body": "..."}.');
      body = value;
    }
    body = body.trim();
    if (!body) throw new HttpError(400, "empty_message", "Message body is empty.");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new HttpError(413, "message_too_large", `Message exceeds ${MAX_BODY_BYTES} bytes.`, "Split it, or summarise and offer details on request.");
    }
    return body;
  }

  function post(p: ParticipantRow, body: string): Response {
    const result = db.transaction(() => {
      const thread = getThread(p.thread_id);
      const side = getSide(p.side_id);
      if (p.kind === "human") {
        const message = insertMessage({ threadId: thread.id, participant: p, kind: "human", author: p.name, body, deliver: true });
        db.query("UPDATE threads SET agent_streak = 0 WHERE id = ?").run(thread.id);
        return { message, note: undefined as string | undefined };
      }
      if (thread.paused) {
        throw new HttpError(
          423,
          "thread_paused",
          "This room is paused, so agents cannot post.",
          "Do not retry. Parley will post in the room when it resumes.",
        );
      }
      if (side.approval) {
        const message = insertMessage({ threadId: thread.id, participant: p, kind: "agent", author: p.name, body, deliver: false });
        return {
          message,
          note: `Held for review by a human on ${side.name}. The other side cannot see it yet. Do not repost; you will be told if it is rejected.`,
        };
      }
      const message = insertMessage({ threadId: thread.id, participant: p, kind: "agent", author: p.name, body, deliver: true });
      const streak = thread.agent_streak + 1;
      if (streak >= streakLimit) {
        db.query("UPDATE threads SET agent_streak = 0, paused = 1 WHERE id = ?").run(thread.id);
        systemMessage(thread.id, `Paused automatically after ${streak} agent messages in a row with no human involvement. A human must resume the room.`);
      } else {
        db.query("UPDATE threads SET agent_streak = ? WHERE id = ?").run(streak, thread.id);
      }
      return { message, note: undefined as string | undefined };
    })();
    bump(p.thread_id);
    return json(
      {
        message: { ...view(result.message), status: result.message.status },
        note: result.note ?? deliveryNote(p),
        participants: publicPresence(p.thread_id),
      },
      201,
    );
  }

  // ---- mailboxes ----------------------------------------------------------

  const threadSummary = (p: ParticipantRow) => {
    const thread = getThread(p.thread_id);
    const side = getSide(p.side_id);
    return {
      id: thread.id,
      title: thread.title,
      paused: thread.paused === 1,
      you: { name: p.name, side: side.name },
      /** True when a human on your side reviews your messages before they are sent. */
      review: side.approval === 1,
    };
  };

  /**
   * Seats an agent in a room. `code` is either a one-time invite or the room link token a side's
   * human holds: whoever has that link can already mint invites, so accepting it adds no new power.
   */
  async function join(req: Request): Promise<Response> {
    const input = await readJson(req);
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!code) throw new HttpError(400, "bad_request", 'Body must be {"code": "<room link token or invite code>"}.');

    let invite: InviteRow | null = null;
    let target: { threadId: string; sideId: string; name: string };
    if (code.startsWith("ph_")) {
      const human = db.query("SELECT * FROM participants WHERE token_hash = ? AND kind = 'human'").get(sha256(code)) as ParticipantRow | null;
      if (!human) throw new HttpError(404, "invalid_link", "This room link is not recognised.", "Copy the full link from the room page, including the part after #.");
      const side = getSide(human.side_id);
      const taken = (db.query("SELECT COUNT(*) AS n FROM participants WHERE side_id = ? AND kind = 'agent'").get(side.id) as { n: number }).n;
      target = { threadId: human.thread_id, sideId: side.id, name: `${side.name} Claude${taken ? ` ${taken + 1}` : ""}` };
    } else {
      invite = db.query("SELECT * FROM invites WHERE code_hash = ?").get(sha256(code)) as InviteRow | null;
      if (!invite) throw new HttpError(404, "invalid_invite", "This invite code is not recognised.", "Ask the human who invited you for a fresh invite.");
      if (invite.redeemed_at) throw new HttpError(410, "invite_used", "This invite was already used. Invites work once.", "Ask your human for a fresh invite.");
      if (invite.expires_at < Date.now()) throw new HttpError(410, "invite_expired", "This invite has expired.", "Ask your human for a fresh invite.");
      target = { threadId: invite.thread_id, sideId: invite.side_id, name: invite.name };
    }

    const existing = bearer(req) ? authMailbox(req) : null;
    const label = (typeof input.label === "string" && input.label.trim().slice(0, 60)) || target.name;

    const result = db.transaction(() => {
      let box = existing;
      let token: string | undefined;
      if (!box) {
        token = newToken("pm");
        const id = newId();
        db.query("INSERT INTO mailboxes (id, address, label, token_hash, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          id,
          `${slug(label)}-${randomBytes(3).toString("hex")}`,
          label,
          sha256(token),
          Date.now(),
          Date.now(),
        );
        box = db.query("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRow;
      }
      const prior = db.query("SELECT * FROM participants WHERE mailbox_id = ? AND thread_id = ?").get(box.id, target.threadId) as ParticipantRow | null;
      if (prior && !prior.revoked) {
        // Joining again with the room link is harmless: the agent keeps its seat and its read mark.
        if (!invite) return { box, token, participant: prior, rejoined: true };
        throw new HttpError(409, "already_member", `This agent is already in the room as ${prior.name}.`, "The invite was not used up; give it to another agent if needed.");
      }
      const id = prior?.id ?? newId();
      if (prior) {
        db.query("UPDATE participants SET revoked = 0, side_id = ?, name = ? WHERE id = ?").run(target.sideId, target.name, id);
      } else {
        db.query(
          "INSERT INTO participants (id, thread_id, side_id, kind, name, mailbox_id, created_at) VALUES (?, ?, ?, 'agent', ?, ?, ?)",
        ).run(id, target.threadId, target.sideId, target.name, box.id, Date.now());
      }
      if (invite) db.query("UPDATE invites SET redeemed_at = ? WHERE id = ?").run(Date.now(), invite.id);
      systemMessage(target.threadId, `${target.name} joined the room.`);
      // The join response carries the history, so everything up to here counts as read.
      db.query("UPDATE participants SET read_seq = ?, last_seen = ? WHERE id = ?").run(maxSeq(target.threadId), Date.now(), id);
      return { box, token, participant: db.query("SELECT * FROM participants WHERE id = ?").get(id) as ParticipantRow, rejoined: false };
    })();
    if (!result.rejoined) bump(target.threadId);

    const p = result.participant;
    const recent = visibleMessages(p, Math.max(0, maxSeq(p.thread_id) - 30));
    return json(
      {
        mailbox: { address: result.box.address, label: result.box.label, token: result.token },
        thread: threadSummary(p),
        recent: recent.map(view),
        participants: publicPresence(p.thread_id),
        instructions: `${baseUrl(req)}/api/agent`,
      },
      result.rejoined ? 200 : 201,
    );
  }

  function getMe(req: Request): Response {
    const box = authMailbox(req);
    return json({ mailbox: { address: box.address, label: box.label }, threads: seats(box).length });
  }

  function getInstructions(req: Request): Response {
    const box = authMailbox(req);
    const text = agentInstructions({ base: baseUrl(req), token: bearer(req)!, address: box.address, maxWait });
    return new Response(text, { headers: { ...noStore, "content-type": "text/markdown; charset=utf-8" } });
  }

  function threadFilter(url: URL): string[] | undefined {
    const raw = url.searchParams.get("threads");
    return raw === null ? undefined : raw.split(",").filter(Boolean);
  }

  /** Parses `seen=<thread>:<seq>,...`: mail a client has already surfaced but not yet acknowledged. */
  function seenMarks(url: URL): Map<string, number> {
    const marks = new Map<string, number>();
    for (const part of (url.searchParams.get("seen") ?? "").split(",")) {
      const [thread, seq] = part.split(":");
      if (thread && Number.isInteger(Number(seq))) marks.set(thread, Number(seq));
    }
    return marks;
  }

  /**
   * One inbox for every thread the mailbox belongs to. Reading does not acknowledge.
   * `threads` narrows it to some threads; `seen` hides mail up to a seq without acknowledging it,
   * so a notifier can wait for mail that is newer than what it already announced.
   */
  async function getInbox(req: Request, url: URL): Promise<Response> {
    const box = authMailbox(req);
    const only = threadFilter(url);
    const seen = seenMarks(url);
    const wait = Math.min(maxWait, Math.max(0, intParam(url, "wait", 0)));
    const collect = () => {
      const threads = seats(box, only)
        .map((p) => ({ p, unread: unreadFor(p, INBOX_PAGE + 1, seen.get(p.thread_id)) }))
        .filter((t) => t.unread.length > 0);
      return threads.length ? threads : null;
    };
    const scope = seats(box, only);
    for (const p of scope) touch(p.id);
    const found =
      wait > 0
        ? await listeningWhile(
            scope.map((p) => p.id),
            () => waitFor([`m:${box.id}`], wait, req.signal, collect),
          )
        : collect();
    const threads = (found ?? []).map(({ p, unread }) => {
      const page = unread.slice(0, INBOX_PAGE);
      return {
        ...threadSummary(p),
        unread: page.map(view),
        /** Pass this to POST /api/inbox/ack once the messages above have been read. */
        ack_seq: page.at(-1)!.seq,
        more: unread.length > INBOX_PAGE,
        pending: pendingFor(p).map(view),
        participants: publicPresence(p.thread_id),
      };
    });
    return json({
      mailbox: { address: box.address, label: box.label },
      unread_count: threads.reduce((n, t) => n + t.unread.length, 0),
      threads,
      timed_out: wait > 0 && found === null,
    });
  }

  async function ackInbox(req: Request): Promise<Response> {
    const box = authMailbox(req);
    const input = await readJson(req);
    if (!Array.isArray(input.acks)) throw new HttpError(400, "bad_request", 'Body must be {"acks": [{"thread": "<id>", "seq": <n>}]}.');
    const touched: string[] = [];
    db.transaction(() => {
      for (const raw of input.acks as { thread?: unknown; seq?: unknown }[]) {
        if (typeof raw?.thread !== "string" || !Number.isInteger(raw.seq)) {
          throw new HttpError(400, "bad_request", 'Each ack must be {"thread": "<id>", "seq": <integer>}.');
        }
        const p = seat(box, raw.thread);
        const seq = Math.min(raw.seq as number, maxSeq(p.thread_id));
        if (seq > p.read_seq) {
          db.query("UPDATE participants SET read_seq = ? WHERE id = ?").run(seq, p.id);
          touched.push(p.thread_id);
        }
      }
    })();
    // Pages show per-agent unread counts, so a read mark is a visible change.
    for (const threadId of touched) {
      db.query("UPDATE threads SET version = version + 1 WHERE id = ?").run(threadId);
      wake(`t:${threadId}`);
    }
    return json({ ok: true });
  }

  function listThreads(req: Request): Response {
    const box = authMailbox(req);
    return json({
      mailbox: { address: box.address, label: box.label },
      threads: seats(box).map((p) => ({
        ...threadSummary(p),
        unread_count: unreadFor(p, 1000).length,
        participants: publicPresence(p.thread_id),
      })),
    });
  }

  /** Full history of one thread. Reading history does not acknowledge mail. */
  function threadHistory(req: Request, url: URL, threadId: string): Response {
    const p = seat(authMailbox(req), threadId);
    const after = Math.max(0, intParam(url, "after", 0));
    const limit = Math.min(500, Math.max(1, intParam(url, "limit", 200)));
    const messages = visibleMessages(p, after, limit);
    return json({
      thread: threadSummary(p),
      messages: messages.map(view),
      cursor: messages.at(-1)?.seq ?? after,
      read_seq: p.read_seq,
      pending: pendingFor(p).map(view),
      participants: publicPresence(p.thread_id),
    });
  }

  // ---- human fallback notifications --------------------------------------

  /** Tells a side's humans when mail has sat unread, i.e. when no agent session picked it up. */
  async function sweep(): Promise<void> {
    const cutoff = Date.now() - notifyDelayMs;
    const sides = db.query("SELECT * FROM sides WHERE notify_url IS NOT NULL").all() as SideRow[];
    for (const side of sides) {
      const stale = db
        .query(
          `SELECT MAX(seq) AS seq, COUNT(*) AS n, GROUP_CONCAT(DISTINCT author) AS authors FROM messages
           WHERE thread_id = ? AND status = 'sent' AND kind != 'system' AND side_id != ? AND seq > ? AND delivered_at <= ?`,
        )
        .get(side.thread_id, side.id, side.notified_seq, cutoff) as { seq: number | null; n: number; authors: string | null };
      if (!stale.seq) continue;
      db.query("UPDATE sides SET notified_seq = ? WHERE id = ?").run(stale.seq, side.id);
      const agents = db
        .query("SELECT read_seq FROM participants WHERE side_id = ? AND kind = 'agent' AND revoked = 0")
        .all(side.id) as { read_seq: number }[];
      if (agents.some((a) => a.read_seq >= stale.seq!)) continue;
      const thread = getThread(side.thread_id);
      const who = agents.length ? "your agent has not picked up" : "no agent is connected on your side to read";
      const text = `Parley: ${who} ${stale.n} message${stale.n === 1 ? "" : "s"} from ${stale.authors} in "${thread.title}".`;
      try {
        const res = await fetch(side.notify_url!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, thread: { id: thread.id, title: thread.title }, unread: stale.n }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) console.error(`notify webhook for side ${side.id} returned ${res.status}`);
      } catch (err) {
        console.error(`notify webhook for side ${side.id} failed: ${(err as Error).message}`);
      }
    }
  }

  const sweepEvery = opts.sweepIntervalMs ?? 15_000;
  const sweeper = sweepEvery > 0 ? setInterval(() => void sweep().catch((err) => console.error(err)), sweepEvery) : null;

  // ---- routing ------------------------------------------------------------

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;
    let match: RegExpExecArray | null;

    if (method === "GET" && path === "/") return html(homePage.replace("__OPEN_ROOMS__", String(opts.openRooms !== false)));
    if (method === "GET" && path === "/t") return html(threadPage);
    if (method === "GET" && path === "/j") return html(invitePage);
    if (method === "GET" && path === "/healthz") return json({ ok: true });
    if (method === "GET" && path === "/favicon.ico") return new Response(null, { status: 204 });
    if (method === "GET" && path === "/install.sh") return installScript(baseUrl(req), opts.distDir);
    if (method === "GET" && (match = /^\/dl\/(parley-[a-z0-9]+-[a-z0-9]+(?:\.gz)?)$/.exec(path))) return clientDownload(match[1]!, opts.distDir);

    // Humans, authenticated by a thread link token.
    if (method === "POST" && path === "/api/threads") return createThread(req);
    if (method === "GET" && path === "/api/state") return getState(req, url);
    if (method === "POST" && path === "/api/messages") {
      const p = authHuman(req);
      return post(p, await readMessageBody(req));
    }
    if (method === "POST" && (match = /^\/api\/messages\/(\d+)\/(approve|reject)$/.exec(path))) {
      return reviewMessage(req, Number(match[1]), match[2] as "approve" | "reject");
    }
    if (method === "POST" && path === "/api/pause") return setPaused(req);
    if (method === "POST" && path === "/api/settings") return setSettings(req);
    if (method === "POST" && path === "/api/invites") return createInvite(req);
    if (method === "POST" && (match = /^\/api\/agents\/([0-9a-f]+)\/revoke$/.exec(path))) return revokeAgent(req, match[1]!);

    // Agents, authenticated by a mailbox token.
    if (method === "POST" && path === "/api/join") return join(req);
    if (method === "GET" && path === "/api/me") return getMe(req);
    if (method === "GET" && path === "/api/agent") return getInstructions(req);
    if (method === "GET" && path === "/api/inbox") return getInbox(req, url);
    if (method === "POST" && path === "/api/inbox/ack") return ackInbox(req);
    if (method === "GET" && path === "/api/threads") return listThreads(req);
    if ((match = /^\/api\/threads\/([0-9a-f]+)\/messages$/.exec(path))) {
      if (method === "GET") return threadHistory(req, url, match[1]!);
      if (method === "POST") {
        const p = seat(authMailbox(req), match[1]!);
        return post(p, await readMessageBody(req));
      }
    }

    throw new HttpError(404, "not_found", `No route for ${method} ${path}.`, "Agents: GET /api/agent returns the full API instructions.");
  }

  async function fetchHandler(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message, hint: err.hint } }, err.status);
      }
      console.error(err);
      return json({ error: { code: "internal", message: "Internal server error." } }, 500);
    }
  }

  return {
    fetch: fetchHandler,
    /** Runs one notification sweep now. Exposed for tests. */
    sweep,
    close: () => {
      if (sweeper) clearInterval(sweeper);
      db.close();
    },
  };
}
