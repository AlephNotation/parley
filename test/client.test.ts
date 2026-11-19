import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN, mail, startServer } from "./helpers";

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
    // With one room here, the reply hint leaves the room id out, as plain `say` reaches it.
    expect(first.stdout).toContain('parley.ts say "<text>"');
    expect(first.stdout).not.toContain(`say ${id}`);
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

describe("errors", () => {
  /** One `parley:` line plus an optional hint, and no stack trace or bundled source. */
  function expectCleanFailure(res: { stdout: string; stderr: string; code: number }, message: string) {
    expect(res.code).toBe(1);
    expect(res.stderr).toStartWith(`parley: ${message}`);
    expect(res.stderr.trim().split("\n").length).toBeLessThanOrEqual(2);
    expect(res.stderr).not.toMatch(/^\s+at /m);
  }

  test("say -f with a missing, empty or unreadable file name fails in one line", async () => {
    const { acme } = await scene();
    expectCleanFailure(await acme.run(["say", "-f", "nope.txt"]), "cannot read nope.txt: no such file");
    expectCleanFailure(await acme.run(["say", "-f"]), "-f needs a file name");
    mkdirSync(join(acme.project, "a-dir"));
    expectCleanFailure(await acme.run(["say", "-f", "a-dir"]), "cannot read a-dir: it is a directory");
  });

  test("a corrupt config is reported by commands, and hooks stay silent", async () => {
    const m = machine();
    mkdirSync(m.home, { recursive: true });
    writeFileSync(join(m.home, "config.json"), "{ not json");
    for (const cmd of [["read"], ["say", "hi"], ["rooms"], ["join", `${s.base}/t#ph_x`]]) {
      expectCleanFailure(await m.run(cmd), `the Parley config ${join(m.home, "config.json")} is not valid JSON`);
    }
    writeFileSync(join(m.home, "config.json"), "[]");
    expectCleanFailure(await m.run(["read"]), "the Parley config");
    expect(await m.run(["hook", "prompt"], { stdin: hookJson(m, "UserPromptSubmit") })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(await m.run(["hook", "wait"], { stdin: hookJson(m, "Stop") })).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  test("an unwritable config directory is reported in one line", async () => {
    const t = await s.thread(false);
    const m = machine();
    writeFileSync(m.home, "a file where the config directory should be");
    expectCleanFailure(await m.run(["join", `${s.base}/t#${t.acmeHuman}`]), `cannot write ${join(m.home, "config.json")}`);
  });

  test("an unreadable or malformed Claude Code settings file is named, and join still succeeds", async () => {
    const t = await s.thread(false);
    const m = machine();
    // The client names the real path; temp directories are symlinks on macOS.
    const path = join(realpathSync(m.project), ".claude", "settings.local.json");
    mkdirSync(path, { recursive: true });
    const joined = await m.run(["join", `${s.base}/t#${t.acmeHuman}`]);
    expect(joined.code).toBe(0);
    expect(joined.stdout).toContain(`Could not set up Claude Code here: cannot read ${path}: it is a directory. Run `);
    expectCleanFailure(await m.run(["setup", "claude-code"]), `cannot read ${path}: it is a directory`);

    const other = machine();
    const bad = join(realpathSync(other.project), ".claude", "settings.local.json");
    mkdirSync(join(other.project, ".claude"));
    writeFileSync(bad, "{ nope");
    expectCleanFailure(await other.run(["setup", "claude-code"]), `${bad} is not valid JSON.`);
    writeFileSync(bad, "null");
    expectCleanFailure(await other.run(["setup", "claude-code"]), `${bad} is not a JSON object.`);
  });
});

describe("reply hints", () => {
  test("every hint uses plain `say` when the directory has one room", async () => {
    const { acme, vers, id, joined } = await scene();
    expect(joined.stdout).toContain('Post: ' );
    expect(joined.stdout).toMatch(/Post: \S+ \S*parley\.ts say "<text>"/);
    const start = JSON.parse((await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "SessionStart") })).stdout).hookSpecificOutput.additionalContext;
    expect(start).toContain('parley.ts say "<text>"');

    const proc = acme.spawn(["hook", "wait"], { stdin: hookJson(acme, "Stop"), env: { PARLEY_HOOK_WAIT: "3" } });
    await Bun.sleep(400);
    await s.send(vers.token, id, "hint check");
    const notice = await new Response(proc.stderr).text();
    expect(notice).toContain('parley.ts say "<text>"');
    const prompt = JSON.parse((await acme.run(["hook", "prompt"], { stdin: hookJson(acme, "UserPromptSubmit") })).stdout).hookSpecificOutput.additionalContext;
    expect(prompt).toContain('parley.ts say "<text>"');
    const read = await acme.run(["read"]);
    expect(read.stdout).toContain('Reply: ');
    expect(read.stdout).toContain('parley.ts say "<text>"');
    for (const text of [joined.stdout, start, notice, prompt, read.stdout]) expect(text).not.toContain(`say ${id}`);
  });

  test("hints name the room when plain `say` would not reach it", async () => {
    const first = await scene();
    const other = await s.thread(false, "Second room");
    const otherVers = await s.seat(other.versHuman);
    await first.acme.run(["join", (await s.invite(other.acmeHuman)).join_url]);
    await s.send(first.vers.token, first.id, "in the first");
    await s.send(otherVers.token, other.id, "in the second");

    const prompt = JSON.parse((await first.acme.run(["hook", "prompt"], { stdin: hookJson(first.acme, "UserPromptSubmit") })).stdout).hookSpecificOutput
      .additionalContext;
    expect(prompt).toContain('say <room id> "<text>"');
    const read = await first.acme.run(["read"]);
    expect(read.stdout).toContain(`say ${first.id} "<text>"`);
    expect(read.stdout).toContain(`say ${other.id} "<text>"`);

    // Reading every room from a directory connected to a different one: that room needs its id.
    const elsewhere = join(first.acme.root, "elsewhere");
    mkdirSync(elsewhere);
    await first.acme.run(["bind", other.id, elsewhere]);
    await s.send(first.vers.token, first.id, "again");
    const all = await first.acme.run(["read", "--all"], { cwd: elsewhere });
    expect(all.stdout).toContain(`say ${first.id} "<text>"`);
  });
});

describe("join output", () => {
  test("says a running session picks the hooks up, rather than asking for a restart", async () => {
    const { joined } = await scene();
    expect(joined.stdout).toContain("already running here picks the hooks up from its next turn");
    expect(joined.stdout).not.toContain("restart it to load them");
  });

  test("tells the agent whether its side's human needs to do anything", async () => {
    const t = await s.thread(false);
    const m = machine();
    const res = await m.run(["join", `${s.base}/t#${t.acmeHuman}`]);
    expect(res.stdout).toContain("Acme (human) [not joined]");
    expect(res.stdout).toContain("Acme (human) has not opened the room yet. Nothing is needed from them for you to take part");

    const reviewed = await s.thread(true);
    const r = await machine().run(["join", `${s.base}/t#${reviewed.acmeHuman}`]);
    expect(r.stdout).toContain("nothing you say goes out until they open your side's link");

    // Once the human has opened the room, nothing is said.
    const seen = await s.thread(false);
    await s.call(seen.acmeHuman, "GET", "/api/state");
    expect((await machine().run(["join", `${s.base}/t#${seen.acmeHuman}`])).stdout).not.toContain("has not opened the room");
  });
});

describe("addressed messages (against a server speaking the audience contract)", () => {
  /** A stand-in for a server with addressed messages: serves a fixed inbox and records posts. */
  function fakeServer(thread: Record<string, unknown>) {
    const posts: { contentType: string; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/api/inbox") return Response.json({ unread_count: 1, threads: [thread], timed_out: false });
        if (req.method === "GET" && url.pathname === "/api/threads") return Response.json({ threads: [thread] });
        if (req.method === "POST" && url.pathname === "/api/inbox/ack") return Response.json({ ok: true });
        if (req.method === "POST" && url.pathname.endsWith("/messages")) {
          posts.push({ contentType: req.headers.get("content-type") ?? "", body: await req.text() });
          return Response.json({ message: { status: "sent", seq: 9 }, note: "Room-wide: Vers Claude woken now." });
        }
        return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      },
    });
    return { base: server.url.origin, posts, stop: () => server.stop(true) };
  }

  const msg = (seq: number, extra: Record<string, unknown>) => ({
    id: seq,
    seq,
    from: "Vers Claude",
    side: "Vers",
    kind: "agent",
    body: `message ${seq}`,
    at: "2026-11-19T04:50:00Z",
    ...extra,
  });

  function roomWith(unread: unknown[], yourHuman = "watching") {
    return {
      id: "abcdef0123456789",
      title: "Addressed",
      paused: false,
      review: false,
      you: { name: "Acme Claude", side: "Acme" },
      participants: [],
      unread,
      ack_seq: 9,
      more: false,
      pending: [],
      your_human: yourHuman,
    };
  }

  function machineOn(base: string) {
    const m = machine();
    mkdirSync(m.home, { recursive: true });
    writeFileSync(
      join(m.home, "config.json"),
      JSON.stringify({
        servers: { [base]: { token: "pm_x", address: "acme-claude-1" } },
        threads: { abcdef0123456789: { server: base, title: "Addressed", dir: m.project } },
      }),
    );
    return m;
  }

  test("say sends --to and --fyi as JSON, plain text otherwise, and rejects bad combinations", async () => {
    const fake = fakeServer(roomWith([]));
    try {
      const m = machineOn(fake.base);
      expect((await m.run(["say", "plain"])).code).toBe(0);
      expect((await m.run(["say", "--to", "Vers, vers-claude-9", "direct one"])).stdout).toContain("Room-wide: Vers Claude woken now.");
      expect((await m.run(["say", "--fyi", "just so you know"])).code).toBe(0);
      expect(fake.posts[0]).toEqual({ contentType: "text/plain", body: "plain" });
      expect(fake.posts[1]!.contentType).toBe("application/json");
      expect(JSON.parse(fake.posts[1]!.body)).toEqual({ body: "direct one", to: ["Vers", "vers-claude-9"] });
      expect(JSON.parse(fake.posts[2]!.body)).toEqual({ body: "just so you know", fyi: true });

      const both = await m.run(["say", "--to", "Vers", "--fyi", "x"]);
      expect(both.code).toBe(1);
      expect(both.stderr).toContain("use --to or --fyi, not both");
      expect((await m.run(["say", "--to", "", "x"])).stderr).toContain("--to needs a name");
      expect(fake.posts.length).toBe(3);
    } finally {
      fake.stop();
    }
  });

  test("read labels each message and says what is expected", async () => {
    const fake = fakeServer(
      roomWith([
        msg(5, { audience: "direct", to: ["acme-claude-1"], woke: true }),
        msg(6, { audience: "room", to: [], woke: false }),
        msg(7, { audience: "fyi", to: [], woke: false }),
        msg(8, { audience: "direct", to: ["Globex"], woke: false }),
      ]),
    );
    try {
      const out = (await machineOn(fake.base).run(["read"])).stdout;
      expect(out).toContain("  [to acme-claude-1]\n    message 5");
      expect(out).toContain("  [fyi]\n    message 7");
      expect(out).toContain("  [to Globex]\n    message 8");
      expect(out).toMatch(/Z\n    message 6/);
      expect(out).toContain("Expected: Addressed to you (#5): a reply is expected.");
      // A message addressed to someone else is room context, not something this agent owes a reply to.
      expect(out).toContain("Room-wide (#6): act only if relevant. If it needs an owner and that is you, say so; if it is nobody, tell your human.");
      expect(out).not.toContain("#8)");
      expect(out).toContain("Your side's human is watching the room.");
    } finally {
      fake.stop();
    }
  });

  test("addressing a side reaches every agent on it, and fyi alone owes nothing", async () => {
    const side = fakeServer(roomWith([msg(5, { audience: "direct", to: ["acme"], woke: true })], "away"));
    const fyi = fakeServer(roomWith([msg(5, { audience: "fyi", to: [], woke: false })], "not_joined"));
    try {
      const sideOut = (await machineOn(side.base).run(["read"])).stdout;
      expect(sideOut).toContain("Addressed to you (#5): a reply is expected. Your side's human is not watching right now.");
      const fyiOut = (await machineOn(fyi.base).run(["read"])).stdout;
      expect(fyiOut).toContain("Expected: For your information only: no reply is owed. Your side's human has not opened the room.");
    } finally {
      side.stop();
      fyi.stop();
    }
  });

  test("a direct message naming this agent, or naming nobody (a two-agent room), is addressed to it", async () => {
    const byName = fakeServer(roomWith([msg(5, { audience: "direct", to: ["acme CLAUDE"], woke: true })]));
    const implicit = fakeServer(roomWith([msg(5, { audience: "direct", to: [], woke: true })]));
    try {
      expect((await machineOn(byName.base).run(["read"])).stdout).toContain("Expected: Addressed to you (#5): a reply is expected.");
      expect((await machineOn(implicit.base).run(["read"])).stdout).toContain("Expected: Addressed to you (#5): a reply is expected.");
      // A plain message in a two-agent room has no [to] tag: nobody was named.
      expect((await machineOn(implicit.base).run(["read", "--peek"])).stdout).not.toContain("[to");
    } finally {
      byName.stop();
      implicit.stop();
    }
  });

  test("a message from your own side's human is called out", async () => {
    const fake = fakeServer(roomWith([msg(5, { from: "Acme (human)", side: "Acme", kind: "human", audience: "room", to: [], woke: true })]));
    try {
      const out = (await machineOn(fake.base).run(["read"])).stdout;
      expect(out).toContain("Expected: Your side's human wrote: they expect a response.");
      expect(out).not.toContain("Room-wide");
    } finally {
      fake.stop();
    }
  });

  test("the wake and prompt notices carry the same expectation", async () => {
    const fake = fakeServer(roomWith([msg(5, { audience: "direct", to: ["Acme"], woke: true })]));
    try {
      const m = machineOn(fake.base);
      const wait = await m.run(["hook", "wait"], { stdin: hookJson(m, "Stop"), env: { PARLEY_HOOK_WAIT: "1" } });
      expect(wait.code).toBe(2);
      expect(wait.stderr).toContain('New on Parley: 1 unread Parley message: 1 in "Addressed" from Vers Claude. Addressed to you (#5): a reply is expected.');
      const prompt = JSON.parse((await m.run(["hook", "prompt"], { stdin: hookJson(m, "UserPromptSubmit") })).stdout).hookSpecificOutput.additionalContext;
      expect(prompt).toContain("Addressed to you (#5): a reply is expected. Your side's human is watching the room.");
    } finally {
      fake.stop();
    }
  });

  test("a server without audience labels reads exactly as before", async () => {
    const thread: Record<string, unknown> = roomWith([msg(5, {})]);
    delete thread.your_human;
    const fake = fakeServer(thread);
    try {
      const out = (await machineOn(fake.base).run(["read"])).stdout;
      expect(out).toContain("message 5");
      expect(out).not.toContain("Expected:");
      expect(out).not.toContain("[to ");
      expect(out).not.toContain("[fyi]");
    } finally {
      fake.stop();
    }
  });
});

describe("addressed messages end to end (real server, three agents)", () => {
  /** Vers posts through the raw API; Acme and Globex are real client installs. */
  async function threeSides() {
    const created = await s.call(ADMIN, "POST", "/api/threads", {
      title: "Three sides",
      sides: [{ name: "Vers" }, { name: "Acme" }, { name: "Globex" }],
    });
    const [vers, acme, globex] = created.data.sides.map((side: { human_url: string }) => side.human_url.split("#")[1]) as string[];
    const id = created.data.thread.id as string;
    const versAgent = await s.seat(vers!);
    const a = machine();
    const g = machine();
    expect((await a.run(["join", `${s.base}/t#${acme}`])).code).toBe(0);
    expect((await g.run(["join", `${s.base}/t#${globex}`])).code).toBe(0);
    return { id, vers: versAgent, acme: a, globex: g };
  }

  test("the addressed agent is told a reply is expected; the other sees it as context and is not woken", async () => {
    const { id, vers, acme, globex } = await threeSides();
    const globexWait = globex.spawn(["hook", "wait"], { stdin: hookJson(globex, "Stop"), env: { PARLEY_HOOK_WAIT: "1" } });
    await Bun.sleep(300);
    const posted = await s.call(vers.token, "POST", `/api/threads/${id}/messages`, { body: "Acme, can you check the 502s?", to: ["Acme"] });
    expect(posted.status).toBe(201);

    const toAcme = await acme.run(["read"]);
    expect(toAcme.stdout).toContain("[to Acme]");
    expect(toAcme.stdout).toMatch(/Expected: Addressed to you \(#\d+\): a reply is expected\./);

    // Globex is not woken by mail addressed to Acme.
    const early = await Promise.race([globexWait.exited, Bun.sleep(1500).then(() => "still waiting")]);
    expect(early).toBe("still waiting");
    globexWait.kill();
    const toGlobex = await globex.run(["read"]);
    expect(toGlobex.stdout).toContain("Acme, can you check the 502s?");
    expect(toGlobex.stdout).toContain("[to Acme]");
    expect(toGlobex.stdout).not.toContain("Addressed to you");
  });

  test("say --to by display name wakes that agent, --fyi wakes nobody, and an unknown name lists who can be addressed", async () => {
    const { acme, globex } = await threeSides();
    const globexWait = globex.spawn(["hook", "wait"], { stdin: hookJson(globex, "Stop"), env: { PARLEY_HOOK_WAIT: "2" } });
    await Bun.sleep(300);
    const direct = await acme.run(["say", "--to", "Globex Claude", "over to you"]);
    expect(direct.code).toBe(0);
    expect(direct.stdout).toContain("Globex Claude is listening and will be notified now.");
    const [notice, code] = await Promise.all([new Response(globexWait.stderr).text(), globexWait.exited]);
    expect(code).toBe(2);
    expect(notice).toContain("Addressed to you");
    await globex.run(["read"]);

    const fyi = await acme.run(["say", "--fyi", "logs are in the usual place"]);
    expect(fyi.code).toBe(0);
    expect(fyi.stdout).toContain("is not woken by this");
    const read = await globex.run(["read"]);
    expect(read.stdout).toContain("[fyi]");
    expect(read.stdout).toContain("For your information only: no reply is owed.");

    const unknown = await acme.run(["say", "--to", "Initech", "hello?"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No agent or side here is called "Initech"');
    expect(unknown.stderr).toContain("You can address:");
    expect(unknown.stderr).toContain("Globex");
  });
});
