import { createApp, type AppOptions } from "../src/app";

export const ADMIN = "test-admin-token";

export function startServer(overrides: Partial<AppOptions> = {}) {
  const app = createApp({
    adminToken: ADMIN,
    streakLimit: 4,
    maxWaitSeconds: 5,
    sweepIntervalMs: 0,
    notifyDelayMs: 0,
    allowPrivateWebhooks: true,
    // Most tests are about something else; the attention budget has its own tests.
    wakeRefillMs: 0,
    // Rate limits have their own tests too.
    roomLimit: 0,
    postLimit: 0,
    ...overrides,
  });
  const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: app.fetch });
  const base = server.url.origin;

  async function call(token: string | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = typeof body === "string" ? "text/plain" : "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  }

  /** Creates a thread and returns each side's human token. */
  async function thread(approval: boolean, title = "Integration debugging") {
    const created = await call(ADMIN, "POST", "/api/threads", {
      title,
      sides: [
        { name: "Vers", approval },
        { name: "Acme", approval },
      ],
    });
    const [versHuman, acmeHuman] = created.data.sides.map((s: { human_url: string }) => s.human_url.split("#")[1]) as [string, string];
    return { id: created.data.thread.id as string, versHuman, acmeHuman };
  }

  const invite = async (human: string) => (await call(human, "POST", "/api/invites", {})).data;

  /** Redeems a fresh invite. Pass an existing mailbox token to seat that mailbox instead of creating one. */
  async function seat(human: string, mailboxToken: string | null = null) {
    const inv = await invite(human);
    const res = await call(mailboxToken, "POST", "/api/join", { code: inv.code });
    return { token: (res.data.mailbox.token ?? mailboxToken) as string, address: res.data.mailbox.address as string, join: res };
  }

  /** A two-sided thread with one agent mailbox seated on each side. */
  async function setup(approval: boolean) {
    const t = await thread(approval);
    const vers = await seat(t.versHuman);
    const acme = await seat(t.acmeHuman);
    return { ...t, vers, acme };
  }

  const send = (token: string, threadId: string, text: string) => call(token, "POST", `/api/threads/${threadId}/messages`, text);
  const inbox = async (token: string, query = "") => (await call(token, "GET", `/api/inbox${query}`)).data;

  return {
    app,
    base,
    call,
    thread,
    invite,
    seat,
    setup,
    send,
    inbox,
    stop: async () => {
      await server.stop(true);
      app.close();
    },
  };
}

/** Bodies of non-system unread mail across the whole inbox. */
export const mail = (data: any): string[] =>
  data.threads.flatMap((t: any) => t.unread.filter((m: any) => m.kind !== "system").map((m: any) => m.body));
