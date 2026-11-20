import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fromSlackText, slackSignature, toSlackText, verifySlackRequest } from "../src/slack";
import { startServer } from "./helpers";

/** A stand-in for the Slack Web API that records what it is asked to post. */
function fakeSlack() {
  const posts: { token: string; channel: string; text: string; thread_ts?: string }[] = [];
  const state = { failPosts: false, users: { U1: { profile: { display_name: "Tynan" } } } as Record<string, unknown> };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const method = new URL(req.url).pathname.split("/").pop();
      const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      const body = (await req.json()) as any;
      if (token !== "xoxb-good") return Response.json({ ok: false, error: "invalid_auth" });
      if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT" });
      if (method === "users.info") return state.users[body.user] ? Response.json({ ok: true, user: state.users[body.user] }) : Response.json({ ok: false, error: "user_not_found" });
      if (method === "chat.postMessage") {
        if (body.channel === "C0NOTIN") return Response.json({ ok: false, error: "not_in_channel" });
        if (state.failPosts) return Response.json({ ok: false, error: "ratelimited" });
        posts.push({ token, channel: body.channel, text: body.text, thread_ts: body.thread_ts });
        return Response.json({ ok: true, ts: "1.0" });
      }
      return Response.json({ ok: false, error: "unknown_method" });
    },
  });
  return { posts, state, url: server.url.origin, stop: () => server.stop(true) };
}

const SECRET = "signing-secret";
let slack: ReturnType<typeof fakeSlack>;
let s: ReturnType<typeof startServer>;
beforeAll(() => {
  slack = fakeSlack();
  s = startServer({ slackApi: slack.url });
});
afterAll(async () => {
  await s.stop();
  slack.stop();
});

async function until(check: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await Bun.sleep(10);
  return check();
}

/** A room whose Acme side has connected a Slack channel. */
async function connected(channel = "C0ACME") {
  const t = await s.setup(false);
  const before = slack.posts.length;
  const res = await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good", signing_secret: SECRET, channel } });
  const manifest = (await s.call(t.acmeHuman, "GET", "/api/slack/manifest")).data;
  const since = () => slack.posts.slice(before).filter((p) => p.channel === channel);
  return { ...t, res, channel, since, eventsUrl: manifest.events_url as string, manifest: manifest.manifest };
}

/** Sends what Slack's Events API would, signed the way Slack signs it. */
async function event(url: string, payload: unknown, opts: { secret?: string; timestamp?: number } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": slackSignature(opts.secret ?? SECRET, timestamp, body) },
    body,
  });
  return { status: res.status, data: (await res.json()) as any };
}
let eventCount = 0;
const typed = (channel: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event_id: `Ev${++eventCount}`,
  event: { type: "message", channel, user: "U1", text, ts: "1700000000.000100", ...extra },
});
const roomBodies = async (human: string) => (await s.call(human, "GET", "/api/state")).data.messages.map((m: any) => `${m.from}: ${m.body}`);

describe("a side's Slack channel mirrors the room", () => {
  test("connecting says hello in the channel, never returns the secrets, and does not replay the room so far", async () => {
    const t = await s.setup(false);
    await s.send(t.vers.token, t.id, "said before Slack was connected");
    const before = slack.posts.length;
    const res = await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good", signing_secret: SECRET, channel: "C0HELLO" } });
    expect(res.status).toBe(200);
    expect(res.data.slack).toEqual({ channel: "C0HELLO" });
    await s.app.mirrorSlack();
    const posts = slack.posts.slice(before);
    expect(posts.length).toBe(1);
    expect(posts[0]!.text).toContain('now shows the Parley room "Integration debugging" as Acme sees it');
    const state = (await s.call(t.acmeHuman, "GET", "/api/state")).data;
    expect(state.slack).toEqual({ channel: "C0HELLO" });
    expect(JSON.stringify(state)).not.toContain("xoxb-good");
    expect(JSON.stringify(state)).not.toContain(SECRET);
    // The other side learns nothing about it.
    expect((await s.call(t.versHuman, "GET", "/api/state")).data.slack).toBeNull();
  });

  test("messages from both sides appear in the channel in order, with text that cannot ping or disguise a link", async () => {
    const t = await connected("C0ORDER");
    await s.send(t.vers.token, t.id, "hello <!channel> see <https://evil.example|your bank> & more");
    await s.send(t.acme.token, t.id, "our own agent's answer");
    expect(await until(() => t.since().length === 3)).toBe(true);
    expect(t.since()[1]!.text).toBe("*Vers Claude* (Vers): hello &lt;!channel&gt; see &lt;https://evil.example|your bank&gt; &amp; more");
    expect(t.since()[2]!.text).toBe("*Acme Claude* (Acme): our own agent's answer");
  });

  test("a message held for the other side's review is not shown until it is approved", async () => {
    const t = await s.setup(true);
    const before = slack.posts.length;
    await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good", signing_secret: SECRET, channel: "C0HELD" } });
    const held = await s.send(t.vers.token, t.id, "waiting for Vers's human");
    await s.app.mirrorSlack();
    const mine = () => slack.posts.slice(before).filter((p) => p.channel === "C0HELD" && p.text.includes("waiting for Vers"));
    expect(mine().length).toBe(0);
    await s.call(t.versHuman, "POST", `/api/messages/${held.data.message.id}/approve`, {});
    expect(await until(() => mine().length === 1)).toBe(true);
  });

  test("a failed post is retried later and nothing is skipped or repeated", async () => {
    const t = await connected("C0RETRY");
    slack.state.failPosts = true;
    await s.send(t.vers.token, t.id, "one");
    await s.send(t.vers.token, t.id, "two");
    await s.app.mirrorSlack();
    expect(t.since().length).toBe(1);
    slack.state.failPosts = false;
    await s.app.mirrorSlack();
    await s.app.mirrorSlack();
    expect(t.since().slice(1).map((p) => p.text)).toEqual(["*Vers Claude* (Vers): one", "*Vers Claude* (Vers): two"]);
  });

  test("a bad token or a channel the app is not in is refused with what to do about it", async () => {
    const t = await s.setup(false);
    const bad = await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-wrong", signing_secret: SECRET, channel: "C0ACME" } });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("slack_error");
    expect(bad.data.error.hint).toContain("Bot User OAuth Token");
    const out = await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good", signing_secret: SECRET, channel: "C0NOTIN" } });
    expect(out.data.error.hint).toContain("/invite @Parley");
    expect((await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good", signing_secret: SECRET, channel: "#general" } })).data.error.code).toBe("bad_slack_channel");
    expect((await s.call(t.acmeHuman, "POST", "/api/settings", { slack: { token: "xoxb-good" } })).status).toBe(400);
    expect((await s.call(t.acme.token, "POST", "/api/settings", { slack: null })).status).toBe(403);
    expect((await s.call(t.acmeHuman, "GET", "/api/state")).data.slack).toBeNull();
  });
});

describe("what is typed in the Slack channel is posted to the room", () => {
  test("a person's message becomes a human message from their side, wakes the other side's agent, and is not echoed back", async () => {
    const t = await connected("C0TYPED");
    const res = await event(t.eventsUrl, typed(t.channel, "Can you check &lt;the logs&gt; at <https://example.com/x|this page>?"));
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && !(await roomBodies(t.versHuman)).at(-1)?.includes("via Slack"); i++) await Bun.sleep(10);
    expect((await roomBodies(t.versHuman)).at(-1)).toBe("Tynan (via Slack): Can you check <the logs> at this page (https://example.com/x)?");
    const state = (await s.call(t.versHuman, "GET", "/api/state")).data;
    expect(state.messages.at(-1)).toMatchObject({ kind: "human", side: "Acme" });
    expect((await s.inbox(t.vers.token)).threads[0].unread.at(-1).body).toContain("Can you check");
    await s.app.mirrorSlack();
    expect(t.since().filter((p) => p.text.includes("Can you check")).length).toBe(0);
  });

  test("the address check answers Slack's challenge, and the manifest carries this side's address", async () => {
    const t = await connected("C0CHALL");
    expect((await event(t.eventsUrl, { type: "url_verification", challenge: "abc123" })).data).toEqual({ challenge: "abc123" });
    expect(t.manifest.settings.event_subscriptions.request_url).toBe(t.eventsUrl);
    expect(t.manifest.oauth_config.scopes.bot).toContain("chat:write");
    expect((await s.call(t.acme.token, "GET", "/api/slack/manifest")).status).toBe(403);
  });

  test("a request that is unsigned, signed with another secret, or old is refused and posts nothing", async () => {
    const t = await connected("C0SIGN");
    const before = (await roomBodies(t.versHuman)).length;
    expect((await event(t.eventsUrl, typed(t.channel, "forged"), { secret: "someone-else" })).status).toBe(401);
    expect((await event(t.eventsUrl, typed(t.channel, "replayed"), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await fetch(t.eventsUrl, { method: "POST", body: JSON.stringify(typed(t.channel, "unsigned")) })).status).toBe(401);
    // The other side's address has no app behind it.
    const other = (await s.call(t.versHuman, "GET", "/api/slack/manifest")).data.events_url;
    expect((await event(other, typed(t.channel, "wrong side"))).status).toBe(404);
    await Bun.sleep(100);
    expect((await roomBodies(t.versHuman)).length).toBe(before);
  });

  test("Slack's retries, bot messages, edits and other channels are ignored", async () => {
    const t = await connected("C0IGNORE");
    const before = (await roomBodies(t.versHuman)).length;
    const once = typed(t.channel, "sent once");
    await event(t.eventsUrl, once);
    await event(t.eventsUrl, once);
    await event(t.eventsUrl, typed(t.channel, "from a bot", { bot_id: "B1" }));
    await event(t.eventsUrl, typed(t.channel, "an edit", { subtype: "message_changed" }));
    await event(t.eventsUrl, typed("C0OTHER", "elsewhere"));
    await Bun.sleep(150);
    expect((await roomBodies(t.versHuman)).slice(before)).toEqual(["Tynan (via Slack): sent once"]);
  });

  test("a message that cannot be posted is answered in a Slack thread with the reason", async () => {
    const t = await connected("C0ARCH");
    await s.call(t.acmeHuman, "POST", "/api/archive", { archived: true });
    await event(t.eventsUrl, typed(t.channel, "too late"));
    expect(await until(() => t.since().some((p) => p.thread_ts === "1700000000.000100"))).toBe(true);
    const reply = t.since().find((p) => p.thread_ts)!;
    expect(reply.text).toContain("Not posted to the room: This room was archived");
  });

  test("disconnecting stops both directions", async () => {
    const t = await connected("C0GONE");
    expect((await s.call(t.acmeHuman, "POST", "/api/settings", { slack: null })).data.slack).toBeNull();
    const count = t.since().length;
    await s.send(t.vers.token, t.id, "after disconnect");
    await s.app.mirrorSlack();
    expect(t.since().length).toBe(count);
    expect((await event(t.eventsUrl, typed(t.channel, "into the void"))).status).toBe(404);
  });
});

describe("Slack text and signatures", () => {
  test("room text is escaped for Slack and Slack text is turned back into plain text", () => {
    expect(toSlackText("a < b & c > d <@U1>")).toBe("a &lt; b &amp; c &gt; d &lt;@U1&gt;");
    expect(fromSlackText("see <https://a.example> and <https://b.example|b> <!here> <#C1|general> &amp;&lt;&gt;")).toBe(
      "see https://a.example and b (https://b.example) @here #general &<>",
    );
  });
  test("a signature is only good with the right secret and a recent timestamp", () => {
    const now = 1_700_000_000_000;
    const ts = String(now / 1000);
    const headers = (sig: string, t = ts) => new Headers({ "x-slack-request-timestamp": t, "x-slack-signature": sig });
    expect(verifySlackRequest("k", headers(slackSignature("k", ts, "body")), "body", now)).toBe(true);
    expect(verifySlackRequest("k", headers(slackSignature("other", ts, "body")), "body", now)).toBe(false);
    expect(verifySlackRequest("k", headers(slackSignature("k", ts, "body")), "tampered", now)).toBe(false);
    expect(verifySlackRequest("k", headers(slackSignature("k", ts, "body")), "body", now + 301_000)).toBe(false);
    expect(verifySlackRequest("k", new Headers(), "body", now)).toBe(false);
  });
});
