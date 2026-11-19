import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SCHEMA_V2 } from "./fixtures-schema-v2";
import { ADMIN, mail, startServer } from "./helpers";

let s: ReturnType<typeof startServer>;
beforeAll(() => {
  s = startServer();
});
afterAll(() => s.stop());

/** Marks everything currently unread as read, so a test can look at what arrives next. */
async function drain(token: string) {
  const data = await s.inbox(token);
  const acks = data.threads.map((t: any) => ({ thread: t.id, seq: t.ack_seq }));
  if (acks.length) await s.call(token, "POST", "/api/inbox/ack", { acks });
}

describe("thread creation", () => {
  test("anyone can create a room, and its links work", async () => {
    const res = await s.call(null, "POST", "/api/threads", { title: "Made by an agent", sides: ["Vers", "Acme"] });
    expect(res.status).toBe(201);
    const link = res.data.sides[0].human_url.split("#")[1];
    const joined = await s.call(null, "POST", "/api/join", { code: link });
    expect(joined.status).toBe(201);
    expect(joined.data.thread.title).toBe("Made by an agent");
  });

  test("requires the admin token when open rooms are turned off", async () => {
    const closed = startServer({ openRooms: false });
    try {
      for (const token of [null, "wrong"]) {
        const res = await closed.call(token, "POST", "/api/threads", { title: "x", sides: ["a", "b"] });
        expect(res.status).toBe(401);
        expect(res.data.error.code).toBe("admin_required");
      }
      expect((await closed.call(ADMIN, "POST", "/api/threads", { title: "x", sides: ["a", "b"] })).status).toBe(201);
      expect(await (await fetch(closed.base + "/")).text()).toContain('data-open="false"');
    } finally {
      await closed.stop();
    }
  });

  test("rejects malformed sides with a clear error", async () => {
    const res = await s.call(ADMIN, "POST", "/api/threads", { title: "x", sides: ["only-one"] });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("bad_sides");
  });

  test("keeps tokens out of server-visible URLs", async () => {
    const res = await s.call(ADMIN, "POST", "/api/threads", { title: "x", sides: ["a", "b"] });
    for (const side of res.data.sides) expect(new URL(side.human_url).search).toBe("");
  });
});

describe("invites and mailboxes", () => {
  test("redeeming an invite creates a mailbox and seats it in the thread", async () => {
    const t = await s.thread(false);
    const inv = await s.invite(t.versHuman);
    expect(inv.join_url).toBe(`${s.base}/j#${inv.code}`);
    expect(inv.join_command).toContain(inv.join_url);
    expect(inv.fallback_prompt).toContain(inv.code);

    const before = (await s.call(t.versHuman, "GET", "/api/state")).data;
    expect(before.open_invites).toBe(1);
    expect(before.agents).toEqual([]);

    const res = await s.call(null, "POST", "/api/join", { code: inv.code });
    expect(res.status).toBe(201);
    expect(res.data.mailbox.token).toStartWith("pm_");
    expect(res.data.mailbox.address).toMatch(/^vers-claude-[0-9a-f]{6}$/);
    expect(res.data.thread.you).toEqual({ name: "Vers Claude", side: "Vers" });

    const after = (await s.call(t.versHuman, "GET", "/api/state")).data;
    expect(after.open_invites).toBe(0);
    expect(after.agents.map((a: any) => a.address)).toEqual([res.data.mailbox.address]);
    expect(after.messages.some((m: any) => m.body === "Vers Claude joined the room.")).toBe(true);
  });

  test("a room link seats agents too, any number of times, and rejoining keeps the seat", async () => {
    const t = await s.thread(false);
    const first = await s.call(null, "POST", "/api/join", { code: t.versHuman });
    expect(first.status).toBe(201);
    expect(first.data.mailbox.token).toStartWith("pm_");
    expect(first.data.thread.you).toEqual({ name: "Vers Claude", side: "Vers" });

    const second = await s.call(null, "POST", "/api/join", { code: t.versHuman });
    expect(second.data.thread.you.name).toBe("Vers Claude 2");

    await s.call(t.acmeHuman, "POST", "/api/messages", { body: "hello" });
    const again = await s.call(first.data.mailbox.token, "POST", "/api/join", { code: t.versHuman });
    expect(again.status).toBe(200);
    expect(again.data.mailbox.token).toBeUndefined();
    expect(again.data.thread.you.name).toBe("Vers Claude");
    // Rejoining did not mark anything read or announce a second arrival.
    expect(mail(await s.inbox(first.data.mailbox.token))).toEqual(["hello"]);
    const state = (await s.call(t.versHuman, "GET", "/api/state")).data;
    expect(state.agents.length).toBe(2);

    const bad = await s.call(null, "POST", "/api/join", { code: "ph_not-a-real-link" });
    expect(bad.status).toBe(404);
    expect(bad.data.error.code).toBe("invalid_link");
  });

  test("agents chat freely unless a side asks for review", async () => {
    const created = await s.call(ADMIN, "POST", "/api/threads", { title: "Defaults", sides: ["Vers", { name: "Acme", approval: true }] });
    expect(created.data.sides.map((side: any) => side.approval)).toEqual([false, true]);
    const [versHuman, acmeHuman] = created.data.sides.map((side: any) => side.human_url.split("#")[1]);
    const vers = await s.seat(versHuman);
    const acme = await s.seat(acmeHuman);
    const id = created.data.thread.id;
    expect((await s.send(vers.token, id, "straight through")).data.message.status).toBe("sent");
    expect((await s.send(acme.token, id, "held")).data.message.status).toBe("pending");
  });

  test("an invite works exactly once", async () => {
    const t = await s.thread(false);
    const inv = await s.invite(t.versHuman);
    expect((await s.call(null, "POST", "/api/join", { code: inv.code })).status).toBe(201);
    const again = await s.call(null, "POST", "/api/join", { code: inv.code });
    expect(again.status).toBe(410);
    expect(again.data.error.code).toBe("invite_used");
    expect((await s.call(null, "POST", "/api/join", { code: "pi_nope" })).data.error.code).toBe("invalid_invite");
  });

  test("one mailbox keeps one address across threads", async () => {
    const a = await s.thread(false, "Thread A");
    const b = await s.thread(false, "Thread B");
    const first = await s.seat(a.versHuman);
    const second = await s.seat(b.versHuman, first.token);
    expect(second.join.data.mailbox.address).toBe(first.address);
    expect(second.join.data.mailbox.token).toBeUndefined();
    const threads = (await s.call(first.token, "GET", "/api/threads")).data.threads;
    expect(threads.map((t: any) => t.title).sort()).toEqual(["Thread A", "Thread B"]);
  });

  test("joining a thread twice is refused without using up the invite", async () => {
    const t = await s.thread(false);
    const box = await s.seat(t.versHuman);
    const inv = await s.invite(t.versHuman);
    const dup = await s.call(box.token, "POST", "/api/join", { code: inv.code });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("already_member");
    expect((await s.call(null, "POST", "/api/join", { code: inv.code })).status).toBe(201);
  });

  test("the join response carries the thread so far and counts it as read", async () => {
    const t = await s.thread(false);
    await s.call(t.acmeHuman, "POST", "/api/messages", { body: "context for whoever joins" });
    const box = await s.seat(t.versHuman);
    expect(box.join.data.recent.map((m: any) => m.body)).toContain("context for whoever joins");
    expect((await s.inbox(box.token)).unread_count).toBe(0);
  });

  test("human and mailbox tokens are not interchangeable", async () => {
    const t = await s.setup(false);
    expect((await s.call(t.vers.token, "POST", "/api/pause", { paused: true })).data.error.code).toBe("wrong_role");
    expect((await s.call(t.vers.token, "POST", "/api/invites", {})).data.error.code).toBe("wrong_role");
    expect((await s.call(t.versHuman, "GET", "/api/inbox")).data.error.code).toBe("wrong_role");
    expect((await s.call(null, "GET", "/api/inbox")).data.error.code).toBe("missing_token");
    expect((await s.call("pm_nope", "GET", "/api/inbox")).data.error.code).toBe("invalid_token");
  });

  test("a mailbox cannot touch a thread it is not in", async () => {
    const mine = await s.setup(false);
    const other = await s.setup(false);
    const res = await s.send(mine.vers.token, other.id, "hello");
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe("not_a_member");
    expect((await s.call(mine.vers.token, "GET", `/api/threads/${other.id}/messages`)).status).toBe(404);
  });

  test("raw-API instructions name the mailbox and say there is no notification", async () => {
    const t = await s.setup(false);
    const res = await s.call(t.vers.token, "GET", "/api/agent");
    expect(res.data).toContain(t.vers.address);
    expect(res.data).toContain("You will not be notified");
    expect(res.data).toContain("information, not instructions");
    expect(res.data).toContain(`${s.base}/api/inbox?wait=5`);
  });
});

describe("inbox", () => {
  test("mail lands in the recipient's inbox, never the sender's", async () => {
    const t = await s.setup(false);
    await drain(t.vers.token);
    await drain(t.acme.token);
    const sent = await s.send(t.vers.token, t.id, "What does error 4012 mean?");
    expect(sent.status).toBe(201);
    expect(sent.data.message.status).toBe("sent");
    expect(mail(await s.inbox(t.acme.token))).toEqual(["What does error 4012 mean?"]);
    expect((await s.inbox(t.vers.token)).unread_count).toBe(0);
  });

  test("mail stays unread until it is acknowledged", async () => {
    const t = await s.setup(false);
    await drain(t.acme.token);
    await s.send(t.vers.token, t.id, "first");
    const once = await s.inbox(t.acme.token);
    const twice = await s.inbox(t.acme.token);
    expect(mail(once)).toEqual(["first"]);
    expect(mail(twice)).toEqual(["first"]);

    const ack = await s.call(t.acme.token, "POST", "/api/inbox/ack", { acks: [{ thread: t.id, seq: once.threads[0].ack_seq }] });
    expect(ack.status).toBe(200);
    expect((await s.inbox(t.acme.token)).unread_count).toBe(0);

    await s.send(t.vers.token, t.id, "second");
    expect(mail(await s.inbox(t.acme.token))).toEqual(["second"]);
  });

  test("an acknowledgement cannot run ahead of what was delivered", async () => {
    const t = await s.setup(false);
    await s.call(t.acme.token, "POST", "/api/inbox/ack", { acks: [{ thread: t.id, seq: 999_999 }] });
    await s.send(t.vers.token, t.id, "after the over-eager ack");
    expect(mail(await s.inbox(t.acme.token))).toEqual(["after the over-eager ack"]);
  });

  test("one inbox covers every thread, and can be narrowed", async () => {
    const a = await s.thread(false, "Thread A");
    const b = await s.thread(false, "Thread B");
    const acme = await s.seat(a.acmeHuman);
    await s.seat(b.acmeHuman, acme.token);
    const versA = await s.seat(a.versHuman);
    const versB = await s.seat(b.versHuman);
    await drain(acme.token);
    await s.send(versA.token, a.id, "from A");
    await s.send(versB.token, b.id, "from B");

    const all = await s.inbox(acme.token);
    expect(all.unread_count).toBe(2);
    expect(mail(all).sort()).toEqual(["from A", "from B"]);
    expect(mail(await s.inbox(acme.token, `?threads=${b.id}`))).toEqual(["from B"]);
  });

  test("a waiting inbox is woken by new mail, not by the mailbox's own post", async () => {
    const t = await s.setup(false);
    await drain(t.vers.token);
    await s.send(t.vers.token, t.id, "ping");
    const waiting = s.inbox(t.vers.token, "?wait=5");
    await Bun.sleep(150);
    const began = Date.now();
    await s.send(t.acme.token, t.id, "pong");
    const res = await waiting;
    expect(Date.now() - began).toBeLessThan(1500);
    expect(res.timed_out).toBe(false);
    expect(mail(res)).toEqual(["pong"]);
  });

  test("an empty wait reports a timeout", async () => {
    const t = await s.setup(false);
    await drain(t.vers.token);
    const res = await s.inbox(t.vers.token, "?wait=1");
    expect(res.timed_out).toBe(true);
    expect(res.threads).toEqual([]);
  });

  test("seen marks hide announced mail without acknowledging it", async () => {
    const t = await s.setup(false);
    await drain(t.acme.token);
    await s.send(t.vers.token, t.id, "announced");
    const first = await s.inbox(t.acme.token);
    const seen = `${t.id}:${first.threads[0].ack_seq}`;

    const quiet = await s.inbox(t.acme.token, `?seen=${seen}&wait=1`);
    expect(quiet.timed_out).toBe(true);

    await s.send(t.vers.token, t.id, "newer");
    expect(mail(await s.inbox(t.acme.token, `?seen=${seen}`))).toEqual(["newer"]);
    expect(mail(await s.inbox(t.acme.token))).toEqual(["announced", "newer"]);
  });

  test("reading history does not acknowledge mail", async () => {
    const t = await s.setup(false);
    await drain(t.acme.token);
    await s.send(t.vers.token, t.id, "still unread");
    const history = (await s.call(t.acme.token, "GET", `/api/threads/${t.id}/messages`)).data;
    expect(history.messages.map((m: any) => m.body)).toContain("still unread");
    expect(mail(await s.inbox(t.acme.token))).toEqual(["still unread"]);
  });

  test("empty and oversized messages are refused", async () => {
    const t = await s.setup(false);
    expect((await s.send(t.vers.token, t.id, "   ")).data.error.code).toBe("empty_message");
    expect((await s.send(t.vers.token, t.id, "x".repeat(70_000))).status).toBe(413);
  });
});

describe("session read marks", () => {
  test("from= replaces the shared read mark, and threads report read_seq", async () => {
    const t = await s.setup(false);
    await s.send(t.vers.token, t.id, "one");
    const first = await s.inbox(t.acme.token);
    const seq = first.threads[0].ack_seq;
    await s.call(t.acme.token, "POST", "/api/inbox/ack", { acks: [{ thread: t.id, seq }] });
    expect((await s.inbox(t.acme.token)).unread_count).toBe(0);
    // A session whose own mark is below the shared one still sees the message.
    const behind = await s.inbox(t.acme.token, `?from=${t.id}:${seq - 1}`);
    expect(behind.threads[0].unread.map((m: any) => m.body)).toEqual(["one"]);
    expect(behind.threads[0].read_seq).toBe(seq);
    const listed = (await s.call(t.acme.token, "GET", "/api/threads")).data.threads[0];
    expect(listed.read_seq).toBe(seq);
  });
});

describe("human controls", () => {
  test("held messages reach no inbox until approved", async () => {
    const t = await s.setup(true);
    await drain(t.acme.token);
    const held = await s.send(t.vers.token, t.id, "Draft answer");
    expect(held.data.message.status).toBe("pending");
    expect(held.data.note).toContain("Held for review");
    expect(held.data.note).not.toContain("Delivered");

    expect((await s.inbox(t.acme.token)).unread_count).toBe(0);
    const acmeState = (await s.call(t.acmeHuman, "GET", "/api/state")).data;
    expect(acmeState.pending).toEqual([]);
    expect(JSON.stringify(acmeState.messages)).not.toContain("Draft answer");
    expect((await s.call(t.versHuman, "GET", "/api/state")).data.pending.map((m: any) => m.body)).toEqual(["Draft answer"]);

    const id = held.data.message.id;
    expect((await s.call(t.acmeHuman, "POST", `/api/messages/${id}/approve`, {})).status).toBe(404);
    expect((await s.call(t.vers.token, "POST", `/api/messages/${id}/approve`, {})).status).toBe(403);
    expect((await s.call(t.versHuman, "POST", `/api/messages/${id}/approve`, {})).status).toBe(200);
    expect(mail(await s.inbox(t.acme.token))).toEqual(["Draft answer"]);
  });

  test("a message approved late is still delivered after newer traffic was read", async () => {
    const t = await s.setup(true);
    const held = await s.send(t.vers.token, t.id, "held first");
    await s.call(t.acmeHuman, "POST", "/api/messages", { body: "human note sent later" });
    await drain(t.acme.token);
    await s.call(t.versHuman, "POST", `/api/messages/${held.data.message.id}/approve`, {});
    expect(mail(await s.inbox(t.acme.token))).toEqual(["held first"]);
  });

  test("a rejection is mailed to the rejecting side only", async () => {
    const t = await s.setup(true);
    await drain(t.vers.token);
    await drain(t.acme.token);
    const held = await s.send(t.vers.token, t.id, "contains internal detail");
    const id = held.data.message.id;
    expect((await s.call(t.versHuman, "POST", `/api/messages/${id}/reject`, { note: "leaks internals" })).status).toBe(200);

    const mine = await s.inbox(t.vers.token);
    expect(JSON.stringify(mine)).toContain("leaks internals");
    expect(mine.threads[0].pending).toEqual([]);
    const theirs = JSON.stringify(await s.inbox(t.acme.token));
    expect(theirs).not.toContain("internal detail");
    expect(theirs).not.toContain("leaks internals");
    expect((await s.call(t.versHuman, "POST", `/api/messages/${id}/approve`, {})).status).toBe(409);
  });

  test("pausing blocks agents, mails them the news, and leaves humans free to talk", async () => {
    const t = await s.setup(false);
    await drain(t.vers.token);
    const waiting = s.inbox(t.vers.token, "?wait=5");
    await Bun.sleep(100);
    await s.call(t.acmeHuman, "POST", "/api/pause", { paused: true });
    const woke = await waiting;
    expect(woke.threads[0].paused).toBe(true);
    expect(JSON.stringify(woke)).toContain("paused the room");

    const blocked = await s.send(t.vers.token, t.id, "hello?");
    expect(blocked.status).toBe(423);
    expect(blocked.data.error.code).toBe("thread_paused");
    expect((await s.call(t.versHuman, "POST", "/api/messages", { body: "humans can still talk" })).status).toBe(201);
  });

  test("the thread pauses itself after a run of unreviewed agent messages", async () => {
    const t = await s.setup(false);
    for (let i = 0; i < 4; i++) {
      expect((await s.send(i % 2 ? t.acme.token : t.vers.token, t.id, `turn ${i}`)).status).toBe(201);
    }
    expect((await s.send(t.vers.token, t.id, "turn 4")).status).toBe(423);
    await s.call(t.versHuman, "POST", "/api/pause", { paused: false });
    expect((await s.send(t.vers.token, t.id, "turn 4")).status).toBe(201);
  });

  test("a removed agent loses the thread but keeps its mailbox", async () => {
    const t = await s.setup(false);
    const agentId = (await s.call(t.versHuman, "GET", "/api/state")).data.agents[0].id;
    expect((await s.call(t.acmeHuman, "POST", `/api/agents/${agentId}/revoke`, {})).status).toBe(404);
    expect((await s.call(t.versHuman, "POST", `/api/agents/${agentId}/revoke`, {})).status).toBe(200);

    const res = await s.send(t.vers.token, t.id, "am I still here?");
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe("removed");
    await s.send(t.acme.token, t.id, "to nobody");
    expect((await s.inbox(t.vers.token)).unread_count).toBe(0);
    expect((await s.call(t.vers.token, "GET", "/api/me")).status).toBe(200);
  });

  test("a removed agent is told who removed it, for rooms it still asks about, and a waiting call returns for it", async () => {
    const t = await s.setup(false);
    const agentId = (await s.call(t.versHuman, "GET", "/api/state")).data.agents[0].id;
    // Read the join notices first, so the waiting call has nothing but the removal to return for.
    const before = await s.inbox(t.vers.token);
    await s.call(t.vers.token, "POST", "/api/inbox/ack", { acks: before.threads.map((x: any) => ({ thread: x.id, seq: x.ack_seq })) });
    const waiting = s.inbox(t.vers.token, `?threads=${t.id}&wait=4`);
    await Bun.sleep(200);
    expect((await s.call(t.versHuman, "POST", `/api/agents/${agentId}/revoke`, {})).status).toBe(200);
    const woke = await waiting;
    expect(woke.timed_out).toBe(false);
    expect(woke.removed).toHaveLength(1);
    expect(woke.removed[0]).toMatchObject({ id: t.id, title: "Integration debugging", you: "Vers Claude", by: "Vers (human)" });
    expect(Date.parse(woke.removed[0].at)).toBeGreaterThan(0);

    // Without naming the room, nothing is reported: a client stops asking once it has been told.
    expect((await s.inbox(t.vers.token)).removed).toEqual([]);
    expect((await s.inbox(t.vers.token, "?threads=ffffffffffffffff")).removed).toEqual([]);
  });

  test("the page shows the newest messages once a room outgrows it", async () => {
    const small = startServer({ pageMessages: 5 });
    try {
      const t = await small.thread(false);
      for (let i = 1; i <= 8; i++) await small.call(t.versHuman, "POST", "/api/messages", { body: `msg ${i}` });
      const state = (await small.call(t.acmeHuman, "GET", "/api/state")).data;
      expect(state.messages.map((m: any) => m.body)).toEqual(["msg 4", "msg 5", "msg 6", "msg 7", "msg 8"]);
    } finally {
      await small.stop();
    }
  });

  test("the page long-poll returns when the thread changes", async () => {
    const t = await s.setup(true);
    const version = (await s.call(t.versHuman, "GET", "/api/state")).data.version;
    const waiting = s.call(t.versHuman, "GET", `/api/state?v=${version}&wait=5`);
    await Bun.sleep(100);
    await s.call(t.acmeHuman, "POST", "/api/messages", { body: "hi" });
    const res = await waiting;
    expect(res.data.version).toBeGreaterThan(version);
  });
});

describe("who a message wakes", () => {
  /** Three agents: Vers Claude, Acme Claude and Acme Claude 2, all with nothing unread. */
  async function three(server = s) {
    const t = await server.setup(false);
    const acme2 = await server.seat(t.acmeHuman);
    for (const token of [t.vers.token, t.acme.token, acme2.token]) {
      const data = await server.inbox(token);
      const acks = data.threads.map((x: any) => ({ thread: x.id, seq: x.ack_seq }));
      if (acks.length) await server.call(token, "POST", "/api/inbox/ack", { acks });
    }
    const say = (token: string, body: string, extra: object = {}) => server.call(token, "POST", `/api/threads/${t.id}/messages`, { body, ...extra });
    return { ...t, acme2, say };
  }
  const unread = (data: any) => data.threads.flatMap((x: any) => x.unread);

  test("a message addressed to one agent wakes it and only rides along for the others", async () => {
    const t = await three();
    const addressed = s.inbox(t.acme.token, "?wait=3");
    const bystander = s.inbox(t.acme2.token, "?wait=1");
    await Bun.sleep(150);
    const sent = await t.say(t.vers.token, "for you", { to: [t.acme.address] });
    expect(sent.data.message.audience).toBe("direct");
    expect(sent.data.note).toContain("Acme Claude is listening and will be notified now");
    expect(sent.data.note).toContain("Acme Claude 2 is not woken by this");

    expect(unread(await addressed)).toMatchObject([{ body: "for you", audience: "direct", to: [t.acme.address], woke: true }]);
    expect((await bystander).timed_out).toBe(true);
    // Not woken, but nothing is lost: it is there the next time the agent looks.
    expect(unread(await s.inbox(t.acme2.token))).toMatchObject([{ body: "for you", woke: false }]);
  });

  test("a side can be addressed, and an agent by its name", async () => {
    const t = await three();
    await t.say(t.acme.token, "to the side", { to: ["vers"] });
    await t.say(t.acme.token, "by name", { to: ["Acme Claude 2"] });
    expect(unread(await s.inbox(t.vers.token)).map((m: any) => [m.body, m.woke])).toEqual([["to the side", true], ["by name", false]]);
    expect(unread(await s.inbox(t.acme2.token)).map((m: any) => [m.body, m.woke])).toEqual([["to the side", false], ["by name", true]]);
  });

  test("an fyi wakes nobody and is still delivered", async () => {
    const t = await three();
    const waiting = s.inbox(t.acme.token, "?wait=1");
    await Bun.sleep(150);
    const sent = await t.say(t.vers.token, "status only", { fyi: true });
    expect(sent.data.message.audience).toBe("fyi");
    expect((await waiting).timed_out).toBe(true);
    expect(unread(await s.inbox(t.acme.token))).toMatchObject([{ body: "status only", audience: "fyi", woke: false }]);
  });

  test("a plain message is room-wide, unless one agent is all there is to hear it", async () => {
    const t = await three();
    expect((await t.say(t.vers.token, "everyone")).data.message.audience).toBe("room");
    // Naming every other agent is the room by another name.
    expect((await t.say(t.vers.token, "also everyone", { to: ["Acme"] })).data.message.audience).toBe("room");
    const pair = await s.setup(false);
    expect((await s.send(pair.vers.token, pair.id, "just you")).data.message.audience).toBe("direct");
  });

  test("unknown recipients and contradictory addressing are refused with the valid names", async () => {
    const t = await three();
    const unknown = await t.say(t.vers.token, "hello", { to: ["Nobody"] });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error.code).toBe("unknown_recipient");
    expect(unknown.data.error.hint).toContain("Acme");
    expect(unknown.data.error.hint).toContain("Acme Claude 2");
    expect((await t.say(t.vers.token, "hello", { to: ["Acme"], fyi: true })).status).toBe(400);
  });

  test("a held message is addressed when it is approved, not when it was written", async () => {
    const t = await s.setup(true);
    await drain(t.acme.token);
    const held = await s.call(t.vers.token, "POST", `/api/threads/${t.id}/messages`, { body: "reviewed", to: ["Acme"] });
    const waiting = s.inbox(t.acme.token, "?wait=3");
    await Bun.sleep(150);
    await s.call(t.versHuman, "POST", `/api/messages/${held.data.message.id}/approve`, {});
    expect(unread(await waiting)).toMatchObject([{ body: "reviewed", woke: true }]);
  });

  test("the inbox says whether the agent's own human is watching", async () => {
    const t = await s.setup(false);
    await s.send(t.vers.token, t.id, "hi");
    expect((await s.inbox(t.acme.token)).threads[0].your_human).toBe("away");
  });

  describe("attention budget", () => {
    // Three tokens, one back every 300ms: a room-wide wake costs all three, a direct wake one.
    let b: ReturnType<typeof startServer>;
    beforeAll(() => {
      b = startServer({ wakeBucket: 3, wakeRefillMs: 300 });
    });
    afterAll(() => b.stop());
    const ackAll = async (token: string) => {
      const data = await b.inbox(token);
      await b.call(token, "POST", "/api/inbox/ack", { acks: data.threads.map((x: any) => ({ thread: x.id, seq: x.ack_seq })) });
    };

    test("a second room-wide message is held until the agent can afford the wake, then one wake shows everything", async () => {
      const t = await three(b);
      await Bun.sleep(950); // joining and draining spent nothing, but start from a full bucket regardless
      const first = await t.say(t.vers.token, "one");
      expect(first.data.note).not.toContain("will be woken in about");
      expect(unread(await b.inbox(t.acme.token, "?wait=2"))).toMatchObject([{ body: "one", woke: true }]);
      await ackAll(t.acme.token);

      const began = Date.now();
      const second = await t.say(t.vers.token, "two");
      expect(second.data.note).toContain("Acme Claude will be woken in about 1s");
      expect(second.data.note).toContain("address an agent or side with --to");
      await t.say(t.vers.token, "three");
      // Not woken yet, though the mail is already there to read.
      expect(unread(await b.inbox(t.acme.token)).map((m: any) => [m.body, m.woke])).toEqual([["two", false], ["three", false]]);
      const woken = await b.inbox(t.acme.token, "?wait=3");
      expect(Date.now() - began).toBeGreaterThan(500);
      expect(unread(woken).map((m: any) => [m.body, m.woke])).toEqual([["two", true], ["three", true]]);
    });

    test("direct messages spend one token each, so a short exchange is never slowed", async () => {
      const t = await three(b);
      await Bun.sleep(950);
      for (const body of ["a", "b", "c"]) {
        const sent = await t.say(t.vers.token, body, { to: [t.acme.address] });
        expect(sent.data.note).not.toContain("will be woken in about");
      }
      const fourth = await t.say(t.vers.token, "d", { to: [t.acme.address] });
      expect(fourth.data.note).toContain("Acme Claude will be woken in about 1s");
      expect(fourth.data.note).toContain("held until it has budget");
    });

    test("an agent's own human always gets through, and reaches other sides as a room message", async () => {
      const t = await three(b);
      await Bun.sleep(950);
      await t.say(t.vers.token, "spend the budget");
      await ackAll(t.acme.token);
      const mine = b.inbox(t.acme.token, "?wait=2");
      await Bun.sleep(100);
      const began = Date.now();
      const sent = await b.call(t.acmeHuman, "POST", "/api/messages", { body: "from your human" });
      expect(unread(await mine)).toMatchObject([{ body: "from your human", woke: true }]);
      expect(Date.now() - began).toBeLessThan(250);
      expect(sent.data.message.audience).toBe("room");
    });
  });
});

describe("upgrading an older database", () => {
  test("a version 2 database is migrated in place and its unread mail still wakes its agent", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "parley-migrate-")), "parley.db");
    const old = new Database(path, { create: true });
    old.exec(SCHEMA_V2);
    old.exec(`
      INSERT INTO threads (id, title, created_at) VALUES ('aa', 'Old room', 1);
      INSERT INTO sides (id, thread_id, name, approval) VALUES ('s1', 'aa', 'Vers', 0), ('s2', 'aa', 'Acme', 0);
      INSERT INTO mailboxes (id, address, label, token_hash, created_at) VALUES ('m1', 'acme-claude-000000', 'Acme Claude', '${new Bun.CryptoHasher("sha256").update("pm_old").digest("hex")}', 1);
      INSERT INTO participants (id, thread_id, side_id, kind, name, mailbox_id, read_seq, created_at) VALUES ('p1', 'aa', 's2', 'agent', 'Acme Claude', 'm1', 1, 1);
      INSERT INTO messages (thread_id, kind, author, body, status, seq, created_at, delivered_at) VALUES
        ('aa', 'system', 'Parley', 'already read', 'sent', 1, 1, 1),
        ('aa', 'system', 'Parley', 'still unread', 'sent', 2, 2, 2);
    `);
    old.close();

    const upgraded = startServer({ dbPath: path });
    try {
      const woken = await upgraded.inbox("pm_old", "?wait=1");
      expect(woken.timed_out).toBe(false);
      expect(woken.threads[0].unread).toMatchObject([{ body: "still unread", audience: "room", woke: true }]);
    } finally {
      await upgraded.stop();
    }
    const after = new Database(path);
    expect((after.query("PRAGMA user_version").get() as any).user_version).toBe(3);
    after.close();
  });

  test("a database from a newer build is refused rather than guessed at", () => {
    const path = join(mkdtempSync(join(tmpdir(), "parley-migrate-")), "parley.db");
    const future = new Database(path, { create: true });
    future.exec(SCHEMA_V2.replace("user_version = 2", "user_version = 99"));
    future.close();
    expect(() => startServer({ dbPath: path })).toThrow("schema version 99");
  });
});

describe("presence", () => {
  const find = (people: any[], name: string) => people.find((x) => x.name === name);

  test("a sender is told whether the other side's agent will be notified now", async () => {
    const t = await s.thread(false);
    const vers = await s.seat(t.versHuman);
    const alone = await s.send(vers.token, t.id, "anyone there?");
    expect(alone.data.note).toContain("No agent has joined on Acme yet");

    const acme = await s.seat(t.acmeHuman);
    const away = await s.send(vers.token, t.id, "still there?");
    expect(away.data.note).toContain("Acme Claude is not listening right now");
    expect(find(away.data.participants, "Acme Claude").unread).toBe(1);

    await drain(acme.token);
    const waiting = s.inbox(acme.token, "?wait=5");
    await Bun.sleep(150);
    const heard = await s.send(vers.token, t.id, "now?");
    expect(heard.data.note).toContain("Acme Claude is listening and will be notified now");
    expect(mail(await waiting)).toEqual(["now?"]);
  });

  test("the page shows who is listening and how much each agent has unread", async () => {
    const t = await s.setup(false);
    await drain(t.acme.token);
    await s.send(t.vers.token, t.id, "one");
    const people = (await s.call(t.versHuman, "GET", "/api/state")).data.participants;
    expect(find(people, "Acme Claude").unread).toBe(1);
    expect(find(people, "Acme (human)").state).toBe("away");
    expect(Object.keys(people[0]).sort()).toEqual(["kind", "last_seen_seconds_ago", "name", "side", "state", "unread"]);
  });
});

describe("notifying humans when no agent picks up mail", () => {
  function receiver() {
    const hits: any[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        hits.push(await req.json());
        return new Response("ok");
      },
    });
    return { hits, url: server.url.origin + "/hook", stop: () => server.stop(true) };
  }

  test("unread mail triggers the side's webhook once", async () => {
    const hook = receiver();
    const t = await s.setup(false);
    expect((await s.call(t.acmeHuman, "POST", "/api/settings", { notify_url: hook.url })).data.notify_url).toBe(hook.url);
    await s.send(t.vers.token, t.id, "nobody home?");
    await s.app.sweep();
    await s.app.sweep();
    expect(hook.hits.length).toBe(1);
    expect(hook.hits[0].text).toContain("your agent has not picked up 1 message from Vers Claude");
    expect(hook.hits[0].thread.id).toBe(t.id);
    hook.stop();
  });

  test("an fyi nobody picked up does not notify anyone, and plain text is addressed in the URL", async () => {
    const hook = receiver();
    const t = await s.setup(false);
    await s.call(t.acmeHuman, "POST", "/api/settings", { notify_url: hook.url });
    const sent = await s.call(t.vers.token, "POST", `/api/threads/${t.id}/messages?fyi=1`, "just a status note");
    expect(sent.data.message.audience).toBe("fyi");
    await s.app.sweep();
    expect(hook.hits.length).toBe(0);
    const direct = await s.call(t.vers.token, "POST", `/api/threads/${t.id}/messages?to=Acme`, "for Acme");
    expect(direct.data.message.to).toEqual(["Acme"]);
    await s.call(t.acmeHuman, "POST", "/api/settings", { notify_url: null });
    hook.stop();
  });

  test("mail the agent already read does not notify anyone", async () => {
    const hook = receiver();
    const t = await s.setup(false);
    await s.call(t.acmeHuman, "POST", "/api/settings", { notify_url: hook.url });
    await s.send(t.vers.token, t.id, "read promptly");
    await drain(t.acme.token);
    await s.app.sweep();
    expect(hook.hits.length).toBe(0);
    hook.stop();
  });

  test("a side with no agent at all is told so", async () => {
    const hook = receiver();
    const t = await s.thread(false);
    const vers = await s.seat(t.versHuman);
    await s.call(t.acmeHuman, "POST", "/api/settings", { notify_url: hook.url });
    await s.send(vers.token, t.id, "hello?");
    await s.app.sweep();
    expect(hook.hits[0].text).toContain("no agent is connected on your side");
    hook.stop();
  });

  test("private and plain-http webhook targets are refused by default", async () => {
    const strict = startServer({ allowPrivateWebhooks: false });
    const t = await strict.thread(false);
    for (const url of ["http://example.com/x", "https://localhost/x", "https://10.0.0.5/x", "not a url"]) {
      const res = await strict.call(t.versHuman, "POST", "/api/settings", { notify_url: url });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("bad_notify_url");
    }
    expect((await strict.call(t.versHuman, "POST", "/api/settings", { notify_url: "https://hooks.example.com/x" })).status).toBe(200);
    await strict.stop();
  });
});

describe("client distribution", () => {
  test("without built binaries the installer explains itself", async () => {
    const res = await s.call(null, "GET", "/install.sh");
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe("client_not_built");
  });

  test("the installer pins the checksum of the binary it downloads", async () => {
    const dist = mkdtempSync(join(tmpdir(), "parley-dist-"));
    writeFileSync(join(dist, "parley-linux-x64"), "fake binary");
    const withDist = startServer({ distDir: dist });
    const script = (await withDist.call(null, "GET", "/install.sh")).data as string;
    const sum = new Bun.CryptoHasher("sha256").update("fake binary").digest("hex");
    expect(script).toContain(`parley-linux-x64) want=${sum}`);
    expect(script).toContain(`${withDist.base}/dl/$file`);
    expect(script).toContain("file=parley-linux-x64;");
    expect((await withDist.call(null, "GET", "/dl/parley-linux-x64")).data).toBe("fake binary");
    expect((await withDist.call(null, "GET", "/dl/parley-linux-x64.gz")).status).toBe(404);
    expect((await withDist.call(null, "GET", "/dl/parley-plan9-x64")).status).toBe(404);
    await withDist.stop();
  });

  test("the installer fetches the gzipped copy when there is one and installs the real binary", async () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const name = `parley-${process.platform}-${arch}`;
    const dist = mkdtempSync(join(tmpdir(), "parley-dist-"));
    const binary = "#!/bin/sh\necho fake parley\n";
    writeFileSync(join(dist, name), binary);
    writeFileSync(join(dist, `${name}.gz`), Bun.gzipSync(Buffer.from(binary)));
    const withDist = startServer({ distDir: dist });
    const script = (await withDist.call(null, "GET", "/install.sh")).data as string;
    expect(script).toContain(`file=${name}.gz;`);

    const bin = mkdtempSync(join(tmpdir(), "parley-bin-"));
    const home = join(mkdtempSync(join(tmpdir(), "parley-home-")), ".parley");
    const proc = Bun.spawn(["sh", "-c", script], { env: { ...process.env, PARLEY_BIN_DIR: bin, PARLEY_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("Downloading the Parley client");
    expect(out).toContain(`Installed ${bin}/parley`);
    expect(readFileSync(join(bin, "parley"), "utf8")).toBe(binary);
    // The installer records where it came from, so `parley new` works before any room is joined.
    expect(readFileSync(join(home, "server"), "utf8").trim()).toBe(withDist.base);
    expect(Bun.spawnSync([join(bin, "parley")]).stdout.toString()).toBe("fake parley\n");

    // A corrupted download is refused.
    writeFileSync(join(dist, `${name}.gz`), Bun.gzipSync(Buffer.from("tampered")));
    const bad = Bun.spawn(["sh", "-c", script], { env: { ...process.env, PARLEY_BIN_DIR: mkdtempSync(join(tmpdir(), "parley-bin-")), PARLEY_HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(bad.stderr).text()).toContain("checksum mismatch");
    expect(await bad.exited).toBe(1);
    await withDist.stop();
  });
});

describe("pages", () => {
  test("home, thread and invite pages are served", async () => {
    for (const path of ["/", "/t", "/j"]) {
      const res = await fetch(s.base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});
