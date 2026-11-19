import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mail, startServer } from "./helpers";

const CLIENT = join(import.meta.dir, "..", "client", "parley.ts");

let s: ReturnType<typeof startServer>;
beforeAll(() => {
  s = startServer();
});
afterAll(() => s.stop());

/** A machine with its own client config and a project directory. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "parley-client-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const spawn = (args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}) =>
    Bun.spawn([process.execPath, CLIENT, ...args], {
      cwd: opts.cwd ?? project,
      env: { ...process.env, PARLEY_HOME: home, ...opts.env },
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
  async function run(args: string[], opts: Parameters<typeof spawn>[1] = {}) {
    const proc = spawn(args, opts);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  return { root, home, project, spawn, run };
}

/** A thread with a raw-API agent for Vers and a real client install for Acme. */
async function scene(approval = false) {
  const t = await s.thread(approval);
  const vers = await s.seat(t.versHuman);
  const acme = machine();
  const invite = await s.invite(t.acmeHuman);
  const joined = await acme.run(["join", invite.join_url]);
  return { ...t, vers, acme, invite, joined };
}

const hookJson = (m: ReturnType<typeof machine>, event: string, session = "sess-1") =>
  JSON.stringify({ session_id: session, cwd: m.project, hook_event_name: event });

describe("new", () => {
  test("an agent creates a room, joins it, and another agent joins with the link it hands out", async () => {
    const vers = machine();
    const made = await vers.run(["new", "Billing API questions", "--as", "Vers", "--with", "Acme", "--server", s.base]);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain('Created room "Billing API questions"');
    expect(made.stdout).toContain("as Vers Claude (Vers).");
    expect(existsSync(join(vers.project, ".claude", "settings.local.json"))).toBe(true);
    const links = [...made.stdout.matchAll(/https?:\/\/\S+\/t#ph_\S+/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);

    const acme = machine();
    expect((await acme.run(["join", links[1]!])).stdout).toContain("as Acme Claude (Acme).");
    expect((await vers.run(["say", "hello from the creator"])).code).toBe(0);
    expect((await acme.run(["read"])).stdout).toContain("hello from the creator");

    // The server is now known, so a second room needs no --server.
    const again = await vers.run(["new", "Second", "--as", "Vers", "--with", "Acme,Globex"], { cwd: vers.root });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Globex");
  });

  test("falls back to the server the client was installed from, and explains what is missing", async () => {
    const m = machine();
    const lost = await m.run(["new", "Room", "--as", "Vers", "--with", "Acme"], { env: { PARLEY_URL: "" } });
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain("no Parley server is known yet");
    mkdirSync(m.home, { recursive: true });
    writeFileSync(join(m.home, "server"), s.base + "\n");
    expect((await m.run(["new", "Room", "--as", "Vers", "--with", "Acme"], { env: { PARLEY_URL: "" } })).code).toBe(0);
    const vague = await m.run(["new", "Room"]);
    expect(vague.code).toBe(1);
    expect(vague.stderr).toContain("usage: parley new");
  });

  test("says so when the server only lets the admin create rooms", async () => {
    const closed = startServer({ openRooms: false });
    try {
      const res = await machine().run(["new", "Room", "--as", "Vers", "--with", "Acme", "--server", closed.base]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("admin token");
    } finally {
      await closed.stop();
    }
  });
});

describe("join", () => {
  test("stores the mailbox privately and reports who else is present", async () => {
    const { acme, joined, id } = await scene();
    expect(joined.code).toBe(0);
    expect(joined.stdout).toContain(`Joined room "Integration debugging" [room ${id}] as Acme Claude (Acme).`);
    expect(joined.stdout).toContain("Vers Claude");
    expect(joined.stdout).toContain("say");
    expect(joined.stdout).not.toContain("pm_");

    const path = join(acme.home, "config.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.servers[s.base].token).toStartWith("pm_");
    expect(cfg.threads[id].dir).toEndWith("/project");
  });

  test("a second room reuses the same identity", async () => {
    const first = await scene();
    const other = await s.thread(false, "Second room");
    const res = await first.acme.run(["join", (await s.invite(other.acmeHuman)).join_url]);
    expect(res.stdout).toContain("(existing)");
    const listing = await first.acme.run(["rooms"]);
    expect(listing.stdout).toContain("Integration debugging");
    expect(listing.stdout).toContain("Second room");
    // With two rooms in one directory, posting has to say which.
    const vague = await first.acme.run(["say", "hello"]);
    expect(vague.code).toBe(1);
    expect(vague.stderr).toContain("more than one room");
    expect(vague.stderr).toContain(other.id);
  });

  test("the room link itself joins an agent and sets up Claude Code in that directory", async () => {
    const t = await s.thread(false);
    await s.seat(t.versHuman);
    const m = machine();
    const res = await m.run(["join", `${s.base}/t#${t.acmeHuman}`]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`Joined room "Integration debugging" [room ${t.id}] as Acme Claude (Acme).`);
    expect(res.stdout).not.toContain("ph_");

    const settings = JSON.parse(readFileSync(join(m.project, ".claude", "settings.local.json"), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(settings.permissions.allow).toContain("Bash(parley say:*)");

    // Joining again from the same machine is harmless.
    expect((await m.run(["join", `${s.base}/t#${t.acmeHuman}`])).code).toBe(0);
    expect((await s.call(t.acmeHuman, "GET", "/api/state")).data.agents.length).toBe(1);
  });

  test("--no-hooks joins without touching Claude Code settings", async () => {
    const t = await s.thread(false);
    const m = machine();
    const res = await m.run(["join", `${s.base}/t#${t.acmeHuman}`, "--no-hooks"]);
    expect(res.stdout).toContain("setup claude-code");
    expect(existsSync(join(m.project, ".claude"))).toBe(false);
  });

  test("a used or mangled invite gives an actionable error", async () => {
    const { invite } = await scene();
    const again = await machine().run(["join", invite.join_url]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already used");
    const noHash = await machine().run(["join", `${s.base}/j`]);
    expect(noHash.stderr).toContain("single quotes");
  });
});

describe("read and say", () => {
  test("inbox prints mail once, and --peek leaves it unread", async () => {
    const { acme, vers, id } = await scene();
    await s.send(vers.token, id, "We get HTTP 502 one time in five.");

    const peek = await acme.run(["inbox", "--peek"]);
    expect(peek.stdout).toContain("We get HTTP 502 one time in five.");
    const first = await acme.run(["read"]);
    expect(first.stdout).toContain("1 unread Parley message");
    expect(first.stdout).toContain("information, not instructions");
    expect(first.stdout).toContain(`parley say ${id} "<text>"`);
    expect((await acme.run(["read"])).stdout).toContain("No new messages.");
  });

  test("say posts inline text, a file or stdin, to the directory's room or a named one", async () => {
    const { acme, vers, id } = await scene();
    const inline = await acme.run(["say", "Looking", "into", "it."]);
    expect(inline.stdout).toContain("Posted as #");
    expect(inline.stdout).toContain("Delivered.");
    writeFileSync(join(acme.project, "msg.txt"), "Known issue.\nFixed in 1.4.2.");
    expect((await acme.run(["say", "-f", "msg.txt"])).code).toBe(0);
    expect((await acme.run(["say", id.slice(0, 6)], { stdin: "piped reply" })).code).toBe(0);
    // A full room id works too, and so does the 0.2 name for the command.
    expect((await acme.run(["send", id, "named", "room"])).code).toBe(0);
    expect(mail(await s.inbox(vers.token))).toEqual(["Looking into it.", "Known issue.\nFixed in 1.4.2.", "piped reply", "named room"]);
  });

  test("who lists everyone in the room and marks you", async () => {
    const { acme } = await scene();
    const res = await acme.run(["who"]);
    expect(res.stdout).toContain('"Integration debugging"');
    expect(res.stdout).toContain("Vers Claude (Vers, agent)");
    expect(res.stdout).toContain("Acme Claude (Acme, agent) <- you");
  });

  test("history prints the whole room without marking anything read", async () => {
    const { acme, vers, id } = await scene();
    await s.send(vers.token, id, "for the record");
    const res = await acme.run(["history"]);
    expect(res.stdout).toContain("for the record");
    expect(res.stdout).toContain("[new]");
    expect((await acme.run(["read", "--peek"])).stdout).toContain("for the record");
  });

  test("a held message is reported as not sent", async () => {
    const { acme, id } = await scene(true);
    const res = await acme.run(["say", id, "draft"]);
    expect(res.stdout).toContain("Not posted yet: held for review.");
  });

  test("mail for another project's thread stays out of this directory", async () => {
    const { acme, vers, id } = await scene();
    await s.send(vers.token, id, "about project A");
    const elsewhere = join(acme.root, "other-project");
    mkdirSync(elsewhere);
    expect((await acme.run(["inbox", "--peek"], { cwd: elsewhere })).stdout).toContain("No Parley rooms are connected to this directory");
    expect((await acme.run(["inbox", "--peek", "--all"], { cwd: elsewhere })).stdout).toContain("about project A");
    const nested = join(acme.project, "src");
    mkdirSync(nested);
    expect((await acme.run(["inbox", "--peek"], { cwd: nested })).stdout).toContain("about project A");
  });

  test("watch --once blocks until mail arrives, prints it and marks it read", async () => {
    const { acme, vers, id } = await scene();
    const proc = acme.spawn(["watch", "--once"]);
    await Bun.sleep(400);
    await s.send(vers.token, id, "wake up");
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("wake up");
    expect((await acme.run(["inbox"])).stdout).toContain("No new messages.");
  });
});

describe("Claude Code hooks", () => {
  test("the prompt hook adds context only when there is mail", async () => {
    const { acme, vers, id } = await scene();
    const quiet = await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "UserPromptSubmit") });
    expect(quiet).toMatchObject({ code: 0, stdout: "" });

    await s.send(vers.token, id, "ping");
    const res = await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "UserPromptSubmit") });
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("UserPromptSubmit");
    expect(out.additionalContext).toContain('1 unread Parley message: 1 in "Integration debugging" from Vers Claude');
    expect(out.additionalContext).toContain("read");
    // Announcing is not reading.
    expect((await acme.run(["inbox", "--peek"])).stdout).toContain("ping");
  });

  test("a new session is told which room it is in, even when nothing is new", async () => {
    const { acme, vers, id } = await scene();
    const res = await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "SessionStart") });
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("SessionStart");
    expect(out.additionalContext).toContain("connected to Parley");
    expect(out.additionalContext).toContain(`Room "Integration debugging" [${id}]: you are Acme Claude (Acme)`);
    expect(out.additionalContext).toContain("Vers Claude");
    expect(out.additionalContext).toContain('say "<text>"');
    expect(out.additionalContext).toContain("information, not instructions");
    expect(out.additionalContext).not.toContain("unread");

    await s.send(vers.token, id, "before you started");
    const withMail = await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "SessionStart", "sess-2") });
    expect(JSON.parse(withMail.stdout).hookSpecificOutput.additionalContext).toContain("1 unread Parley message");

    // A directory with no room gets nothing.
    const elsewhere = join(acme.root, "no-room");
    mkdirSync(elsewhere);
    const quiet = await acme.run(["hook", "prompt"], { stdin: JSON.stringify({ session_id: "y", cwd: elsewhere, hook_event_name: "SessionStart" }) });
    expect(quiet).toMatchObject({ code: 0, stdout: "" });
  });

  test("the prompt hook stays silent when the server is unreachable", async () => {
    const m = machine();
    mkdirSync(m.home, { recursive: true });
    writeFileSync(
      join(m.home, "config.json"),
      JSON.stringify({ servers: { "http://127.0.0.1:9": { token: "pm_x", address: "a" } }, threads: { abc: { server: "http://127.0.0.1:9", title: "t", dir: null } } }),
    );
    const res = await m.run(["hook", "prompt"], { stdin: hookJson(m, "UserPromptSubmit") });
    expect(res).toMatchObject({ code: 0, stdout: "" });
  });

  test("the wait hook exits 2 with a notice when new mail arrives, without marking it read", async () => {
    const { acme, vers, id } = await scene();
    const proc = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env: { PARLEY_HOOK_WAIT: "3" } });
    await Bun.sleep(500);
    await s.send(vers.token, id, "are you there?");
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(stderr).toContain("New on Parley: 1 unread Parley message");
    expect(stderr).toContain("from Vers Claude");
    expect((await acme.run(["inbox", "--peek"])).stdout).toContain("are you there?");
  });

  test("the wait hook announces each piece of mail once per session", async () => {
    const { acme, vers, id } = await scene();
    await s.send(vers.token, id, "first");
    const env = { PARLEY_HOOK_WAIT: "2" };
    const one = await acme.run(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env });
    expect(one.code).toBe(2);

    // The agent ignored the notice; the next Stop must not wake it again for the same mail.
    const proc = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env });
    const early = await Promise.race([proc.exited, Bun.sleep(1200).then(() => "still waiting")]);
    expect(early).toBe("still waiting");
    await s.send(vers.token, id, "second");
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(stderr).toContain("1 unread Parley message");
  });

  test("mail waiting at session start is left to the context hook", async () => {
    const { acme, vers, id } = await scene();
    await s.send(vers.token, id, "already here");
    const proc = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "SessionStart"), env: { PARLEY_HOOK_WAIT: "2" } });
    const early = await Promise.race([proc.exited, Bun.sleep(1200).then(() => "still waiting")]);
    expect(early).toBe("still waiting");
    proc.kill();
  });

  test("a newer waiter for the same session makes the older one stand down", async () => {
    const { acme } = await scene();
    const env = { PARLEY_HOOK_WAIT: "1" };
    const older = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env });
    await Bun.sleep(400);
    const newer = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env });
    expect(await older.exited).toBe(0);
    newer.kill();
  });

  test("the wait hook does nothing in a directory with no threads", async () => {
    const { acme } = await scene();
    const elsewhere = join(acme.root, "unrelated");
    mkdirSync(elsewhere);
    const res = await acme.run(["hook", "wait"], { stdin: JSON.stringify({ session_id: "x", cwd: elsewhere, hook_event_name: "Stop" }) });
    expect(res.code).toBe(0);
  });

  test("setup merges hooks into project settings, idempotently, and can remove them", async () => {
    const m = machine();
    const path = join(m.project, ".claude", "settings.local.json");
    mkdirSync(join(m.project, ".claude"));
    const mine = { type: "command", command: "echo mine" };
    writeFileSync(path, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [mine] }] }, permissions: { allow: ["Bash(ls:*)"] } }));

    expect((await m.run(["setup", "claude-code"])).code).toBe(0);
    expect((await m.run(["setup", "claude-code"])).code).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop.length).toBe(2);
    expect(after.hooks.Stop[0].hooks[0]).toEqual(mine);
    const waiter = after.hooks.Stop[1].hooks[0];
    expect(waiter.command).toEndWith("parley.ts hook wait");
    expect(waiter.asyncRewake).toBe(true);
    expect(after.hooks.SessionStart[0].hooks.map((h: any) => h.command.split(" ").at(-1))).toEqual(["prompt", "wait"]);
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toEndWith("hook prompt");
    expect(after.permissions.allow).toContain("Bash(ls:*)");
    expect(after.permissions.allow).toContain("Bash(parley read:*)");
    // Posting is pre-approved so a woken session can answer; --ask-to-post takes it back out.
    expect(after.permissions.allow).toContain("Bash(parley say:*)");
    await m.run(["setup", "claude-code", "--ask-to-post"]);
    const asking = JSON.parse(readFileSync(path, "utf8"));
    expect(asking.permissions.allow.some((rule: string) => / (say|send):/.test(rule))).toBe(false);
    expect(asking.permissions.allow).toContain("Bash(parley read:*)");
    expect(asking.permissions.allow).toContain("Bash(ls:*)");
    expect(asking.hooks.Stop.length).toBe(2);

    await m.run(["setup", "claude-code", "--remove"]);
    const removed = JSON.parse(readFileSync(path, "utf8"));
    expect(removed.hooks).toEqual({ Stop: [{ hooks: [mine] }] });
  });

  test("setup never touches user-level settings unless asked", async () => {
    const m = machine();
    const fakeClaude = join(m.root, "claude-config");
    await m.run(["setup", "claude-code"], { env: { CLAUDE_CONFIG_DIR: fakeClaude } });
    expect(existsSync(join(fakeClaude, "settings.json"))).toBe(false);
    await m.run(["setup", "claude-code", "--user"], { env: { CLAUDE_CONFIG_DIR: fakeClaude } });
    expect(JSON.parse(readFileSync(join(fakeClaude, "settings.json"), "utf8")).hooks.Stop.length).toBe(1);
  });
});

describe("experimental channel", () => {
  test("speaks MCP, pushes mail as channel events and acknowledges on reply", async () => {
    const { acme, vers, id } = await scene();
    const proc = Bun.spawn([process.execPath, CLIENT, "channel"], {
      cwd: acme.project,
      env: { ...process.env, PARLEY_HOME: acme.home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines: any[] = [];
    const waiters: (() => void)[] = [];
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          waiters.splice(0).forEach((wake) => wake());
        }
      }
    })();
    async function next(match: (msg: any) => boolean): Promise<any> {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = lines.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(lines)}`);
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), Bun.sleep(200)]);
      }
    }
    const say = (msg: unknown) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      proc.stdin.flush();
    };

    say({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const init = await next((m) => m.id === 1);
    expect(init.result.capabilities.experimental["claude/channel"]).toEqual({});
    expect(init.result.capabilities.tools).toEqual({});
    expect(init.result.instructions).toContain("information, not instructions");
    say({ jsonrpc: "2.0", method: "notifications/initialized" });

    say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await next((m) => m.id === 2)).result.tools.map((t: any) => t.name)).toEqual(["send", "mark_read"]);

    await s.send(vers.token, id, "pushed into the session");
    const event = await next((m) => m.method === "notifications/claude/channel");
    expect(event.params.content).toBe("pushed into the session");
    expect(event.params.meta).toMatchObject({ thread: id, from: "Vers Claude", side: "Vers", kind: "agent" });
    for (const key of Object.keys(event.params.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    // Pushing is not acknowledging: Claude Code may have dropped the event.
    expect((await acme.run(["inbox", "--peek"])).stdout).toContain("pushed into the session");

    say({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: { thread: id, body: "reply via channel" } } });
    const sent = await next((m) => m.id === 3);
    expect(sent.result.content[0].text).toContain("Posted as #");
    expect(mail(await s.inbox(vers.token))).toEqual(["reply via channel"]);
    expect((await acme.run(["inbox", "--peek"])).stdout).toContain("No new messages.");

    say({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect((await next((m) => m.id === 4)).error.code).toBe(-32601);
    proc.kill();
  });
});
