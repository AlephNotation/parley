import { describe, expect, test } from "bun:test";
import { invitePage, homePage, threadPage } from "../src/ui";

// ---- minimal DOM harness to execute thread.html's script directly ----

class FakeNode {
  nodeType: number;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  _text = "";

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(val: string) {
    if (this.nodeType === 3) {
      this._text = String(val);
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = String(val);
    if (s) this.append(new FakeText(s));
  }

  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.insertBefore(child, ref);
      return node;
    }
    if (node.parentNode) node.remove();
    node.parentNode = this;
    if (ref === null || ref === undefined) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx < 0) this.childNodes.push(node);
      else this.childNodes.splice(idx, 0, node);
    }
    return node;
  }

  append(...items: Array<FakeNode | string>) {
    for (const item of items) {
      this.insertBefore(typeof item === "string" ? new FakeText(item) : item, null);
    }
  }

  replaceChildren(...items: Array<FakeNode | string>) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...items);
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super(3);
    this._text = String(text);
  }
}

class FakeFragment extends FakeNode {
  constructor() {
    super(11);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  id = "";
  className = "";
  value = "";
  hidden = false;
  checked = false;
  disabled = false;
  type = "";
  title = "";
  href = "";
  rel = "";
  target = "";
  download = "";
  dateTime = "";
  tabIndex = -1;
  start = 1;
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  clientHeight = 400;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: any) => any>> = {};
  onclick: ((e?: any) => any) | null = null;
  onchange: ((e?: any) => any) | null = null;
  onkeydown: ((e?: any) => any) | null = null;
  doc: FakeDocument;

  constructor(tag: string, doc: FakeDocument) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.doc = doc;
  }

  get scrollHeight(): number {
    return this.childNodes.length * 50;
  }

  get options(): FakeElement[] {
    return this.children.filter((c) => c.tagName === "OPTION");
  }

  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...cls: string[]) => {
        const s = new Set(get());
        for (const c of cls) s.add(c);
        this.className = [...s].join(" ");
      },
      remove: (...cls: string[]) => {
        const s = new Set(get());
        for (const c of cls) s.delete(c);
        this.className = [...s].join(" ");
      },
      contains: (c: string) => get().includes(c),
    };
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k]! : null;
  }

  addEventListener(type: string, fn: (e: any) => any) {
    (this.listeners[type] ??= []).push(fn);
  }

  async dispatch(type: string, event: any = {}) {
    event.preventDefault ??= () => {};
    event.target ??= this;
    if (type === "click" && this.onclick) await this.onclick(event);
    if (type === "change" && this.onchange) await this.onchange(event);
    if (type === "keydown" && this.onkeydown) await this.onkeydown(event);
    for (const fn of this.listeners[type] ?? []) await fn(event);
  }

  async click() {
    await this.dispatch("click");
  }

  focus() {
    this.doc.activeElement = this;
  }

  scrollIntoView() {}

  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeNode) => {
      for (const c of node.childNodes) {
        if (c instanceof FakeElement) {
          if (pred(c)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel: string): FakeElement | null {
    const seqMatch = /^\[data-seq="([^"]+)"\]$/.exec(sel);
    if (seqMatch) return this.findAll((el) => el.dataset.seq === seqMatch[1])[0] ?? null;
    if (sel.startsWith(".")) return this.findAll((el) => el.classList.contains(sel.slice(1)))[0] ?? null;
    return this.findAll((el) => el.tagName === sel.toUpperCase())[0] ?? null;
  }
}

class FakeDocument {
  title = "Parley";
  hidden = false;
  activeElement: FakeElement | null = null;
  body: FakeElement;
  byId = new Map<string, FakeElement>();
  listeners: Record<string, Array<(e: any) => any>> = {};

  constructor() {
    this.body = new FakeElement("body", this);
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  createDocumentFragment() {
    return new FakeFragment();
  }
  getElementById(id: string) {
    return this.byId.get(id) ?? null;
  }
  addEventListener(type: string, fn: (e: any) => any) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string, event: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

interface HarnessOptions {
  storage?: Record<string, string>;
  notificationPermission?: "default" | "granted" | "denied";
  requestPermissionResult?: "granted" | "denied";
  fetchImpl?: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
}

function loadThreadUi(opts: HarnessOptions = {}) {
  const [markup, rest] = threadPage.split("<script>") as [string, string];
  const script = rest.slice(0, rest.lastIndexOf("</script>"));
  const doc = new FakeDocument();

  // Instantiate a FakeElement for every tagged element with id="..." in thread.html
  for (const m of markup.matchAll(/<(\w+)\b[^>]*\bid="([\w-]+)"/g)) {
    const [, tag, id] = m;
    const el = new FakeElement(tag!, doc);
    el.id = id!;
    doc.byId.set(id!, el);
  }

  const store = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };

  const clipboardCalls: string[] = [];
  const navigator = {
    clipboard: {
      writeText: async (text: string) => { clipboardCalls.push(text); },
    },
  };

  const notifications: Array<{ title: string; body?: string }> = [];
  class FakeNotification {
    static permission: string = opts.notificationPermission ?? "default";
    static async requestPermission() {
      FakeNotification.permission = opts.requestPermissionResult ?? "granted";
      return FakeNotification.permission;
    }
    constructor(title: string, options?: { body?: string }) {
      notifications.push({ title, body: options?.body });
    }
  }

  const fetchCalls: Array<{ url: string; init?: any }> = [];
  const fetchMock = async (url: string, init?: any) => {
    fetchCalls.push({ url, init });
    if (opts.fetchImpl) return opts.fetchImpl(url, init);
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const location = { hash: "", origin: "https://parley.test", href: "https://parley.test/t#tok" };
  const history = { replaceState: () => {} };

  const runner = new Function(
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "Notification",
    "fetch",
    "confirm",
    "prompt",
    script +
      "\nreturn { inline, formatted, render, applySlim, renderLog, loadEarlier, renderTo, renderNotifyError, loop, getInternals: () => ({ current, version, hasMore, unreadWhileHidden }) };",
  );

  const fns = runner(
    doc,
    location,
    history,
    localStorage,
    navigator,
    FakeNotification,
    fetchMock,
    () => true,
    () => null,
  );

  return { doc, store, clipboardCalls, notifications, fetchCalls, Notification: FakeNotification, fns };
}

function makeState(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    thread: { id: "t1", title: "Release Sync", paused: false, archived: null },
    you: { id: "h1", name: "Vers human", kind: "human", side: "Vers" },
    sides: [
      { id: "s1", name: "Vers", yours: true, approval: false },
      { id: "s2", name: "Acme", yours: false, approval: false },
    ],
    participants: [
      { id: "h1", name: "Vers human", kind: "human", side: "Vers", state: "listening", last_seen_seconds_ago: 0, unread: 0 },
      { id: "a1", name: "Vers Claude", kind: "agent", side: "Vers", state: "listening", last_seen_seconds_ago: 2, unread: 0 },
      { id: "a2", name: "Acme Claude", kind: "agent", side: "Acme", state: "listening", last_seen_seconds_ago: 5, unread: 0 },
    ],
    agents: [{ id: "a1", name: "Vers Claude", address: "vers-claude-abc" }],
    messages: [
      { id: 1, seq: 1, kind: "agent", from: "Acme Claude", side: "Acme", body: "Hello from Acme", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
    ],
    pending: [],
    unowned: null,
    notify_url: null,
    notify_error: null,
    has_more: false,
    ...overrides,
  };
}

// ---- static source invariants ----

describe("page source", () => {
  test("pages are self-contained: no external scripts, stylesheets or fonts", () => {
    for (const page of [threadPage, homePage, invitePage]) {
      expect(page).not.toMatch(/<script[^>]+src=/i);
      expect(page).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
      expect(page).not.toMatch(/@import|@font-face|url\(\s*["']?https?:/i);
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
    }
  });

  test("the room page never builds markup from strings", () => {
    // Message text is untrusted: it must only ever reach the page through textContent and DOM nodes.
    expect(threadPage).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/);
  });

  test("every element the room page script looks up exists in its markup", () => {
    const [markup, script] = threadPage.split("<script>") as [string, string];
    const wanted = new Set([...script.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]!));
    for (const tab of ["online", "setup"]) wanted.add(`tab-${tab}`).add(`panel-${tab}`);
    expect(wanted.size).toBeGreaterThan(20);
    for (const id of wanted) expect(markup).toContain(`id="${id}"`);
  });

  test("the room page writes each message as a messenger line and groups the Buddy List by side", () => {
    expect(threadPage).toContain('head.append(who, " ", time, ...audienceBadges(m, state, toMe), ": ");');
    expect(threadPage).toContain("state.participants.filter((x) => x.side === name)");
  });

  test("the room page flags a room-wide message nobody picked up, from the state's unowned field", () => {
    expect(threadPage).toContain('<div id="unowned" role="status" hidden></div>');
    expect(threadPage).toContain("const u = state.unowned;");
    expect(threadPage).toContain("renderUnowned(state);");
  });

  test("the room page has the audience picker and sends it with optional human display name", () => {
    expect(threadPage).toContain('<select id="to">');
    expect(threadPage).toContain("{ fyi: true }");
    expect(threadPage).toContain('api("/api/messages", Object.assign({ body }, audienceBody(), from ? { from } : {}))');
  });

  test("the room page can replace its side's link and keeps working with the new one", () => {
    expect(threadPage).toContain('id="rotate"');
    expect(threadPage).toContain('api("/api/link/rotate", {})');
    expect(threadPage).toContain('history.replaceState(null, "", "#" + token)');
    expect(threadPage).toMatch(/let token = location\.hash\.slice\(1\)/);
  });

  test("the room page passes slim=1 when polling with an existing version", () => {
    expect(threadPage).toContain('"/api/state?v=" + version + "&wait=25" + (version >= 0 ? "&slim=1" : "")');
    expect(threadPage).toContain("if (data.unchanged && current) applySlim(data);");
  });
});

// ---- behavioral tests ----

describe("markdown formatting (DOM-only)", () => {
  test("supports *italic* and _italic_ without italicizing snake_case identifiers", () => {
    const { doc, fns } = loadThreadUi();
    const wrap = doc.createElement("div");
    wrap.append(fns.formatted("Check *star italic*, _under italic_, read_seq, foo_bar_baz, and 2 * 3 * 4."));
    const ems = wrap.findAll((el) => el.tagName === "EM").map((el) => el.textContent);
    expect(ems).toEqual(["star italic", "under italic"]);
    expect(wrap.textContent).toContain("read_seq");
    expect(wrap.textContent).toContain("foo_bar_baz");
    expect(wrap.textContent).toContain("2 * 3 * 4");
  });

  test("groups consecutive > lines into a blockquote", () => {
    const { doc, fns } = loadThreadUi();
    const wrap = doc.createElement("div");
    wrap.append(fns.formatted("Before\n> Quoted *one*\n> Quoted two\n\nAfter"));
    const quotes = wrap.findAll((el) => el.tagName === "BLOCKQUOTE");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.textContent).toContain("Quoted one");
    expect(quotes[0]!.textContent).toContain("Quoted two");
    expect(quotes[0]!.findAll((el) => el.tagName === "EM")[0]?.textContent).toBe("one");
  });

  test("renders Markdown pipe tables inside an overflow wrapper with alignment and inline formatting", () => {
    const { doc, fns } = loadThreadUi();
    const wrap = doc.createElement("div");
    const md = [
      "| Service | Status | Latency |",
      "| :--- | :---: | ---: |",
      "| `api` | **ok** | *12ms* |",
      "| worker | ok | 4ms |",
    ].join("\n");
    wrap.append(fns.formatted(md));
    const tableWrap = wrap.querySelector(".table-wrap");
    expect(tableWrap).not.toBeNull();
    const headers = tableWrap!.findAll((el) => el.tagName === "TH");
    expect(headers.map((h) => h.textContent)).toEqual(["Service", "Status", "Latency"]);
    expect(headers[0]!.style.textAlign).toBe("left");
    expect(headers[1]!.style.textAlign).toBe("center");
    expect(headers[2]!.style.textAlign).toBe("right");
    const rows = tableWrap!.findAll((el) => el.tagName === "TBODY")[0]!.findAll((el) => el.tagName === "TR");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.findAll((el) => el.tagName === "CODE")[0]?.textContent).toBe("api");
    expect(rows[0]!.findAll((el) => el.tagName === "STRONG")[0]?.textContent).toBe("ok");
    expect(rows[0]!.findAll((el) => el.tagName === "EM")[0]?.textContent).toBe("12ms");
  });

  test("adds a Copy button to fenced code blocks that copies raw code and shows Copied", async () => {
    const { doc, clipboardCalls, fns } = loadThreadUi();
    const wrap = doc.createElement("div");
    wrap.append(fns.formatted("```ts\nconst x = 1;\nconsole.log(x);\n```"));
    const block = wrap.querySelector(".codeblock");
    expect(block).not.toBeNull();
    const pre = block!.querySelector("pre");
    expect(pre!.textContent).toBe("const x = 1;\nconsole.log(x);");
    const btn = block!.querySelector(".copy-code");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("Copy");
    await btn!.click();
    expect(clipboardCalls).toEqual(["const x = 1;\nconsole.log(x);"]);
    expect(btn!.textContent).toBe("Copied");
  });

  test("keeps untrusted HTML as literal text across all Markdown constructs", () => {
    const { doc, fns } = loadThreadUi();
    const wrap = doc.createElement("div");
    wrap.append(fns.formatted("> <script>x</script>\n\n| <img src=x> | b |\n|---|---|\n| <b>c</b> | *<svg>* |"));
    expect(wrap.findAll((el) => ["SCRIPT", "IMG", "B", "SVG"].includes(el.tagName))).toHaveLength(0);
    expect(wrap.textContent).toContain("<script>x</script>");
    expect(wrap.textContent).toContain("<img src=x>");
  });
});

describe("slim polling and incremental log rendering", () => {
  test("applySlim updates people/unowned/to without touching #log or #pending, and render preserves existing message DOM nodes", () => {
    const { doc, fns } = loadThreadUi();
    const s1 = makeState();
    fns.render(s1);

    const log = doc.getElementById("log")!;
    const msg1Node = log.findAll((el) => el.dataset.id === "1")[0]!;
    expect(msg1Node).toBeDefined();

    // User selects a recipient in #to
    const toSelect = doc.getElementById("to")!;
    toSelect.value = "agent:Acme Claude";

    // Slim poll with unchanged: true updates presence and unowned without touching #log or resetting #to
    fns.applySlim({
      unchanged: true,
      version: 1,
      participants: [
        ...s1.participants.slice(0, 2),
        { id: "a2", name: "Acme Claude", kind: "agent", side: "Acme", state: "away", last_seen_seconds_ago: 120, unread: 1 },
      ],
      unowned: { seqs: [1], from: "Acme Claude", since: "2026-11-23T12:00:00Z", read_by: ["Vers Claude"] },
    });

    expect(log.findAll((el) => el.dataset.id === "1")[0]).toBe(msg1Node);
    expect(toSelect.value).toBe("agent:Acme Claude");
    expect(doc.getElementById("unowned")!.hidden).toBe(false);
    expect(doc.getElementById("people")!.textContent).toContain("1 unread");

    // Version bumps with a new message: msg1 DOM node identity is STILL preserved!
    const s2 = makeState({
      version: 2,
      messages: [
        ...s1.messages,
        { id: 2, seq: 2, kind: "agent", from: "Vers Claude", side: "Vers", body: "Got it!", at: "2026-11-23T12:01:00Z", audience: "room", to: [] },
      ],
    });
    fns.render(s2);

    const afterMsg1 = log.findAll((el) => el.dataset.id === "1")[0];
    const afterMsg2 = log.findAll((el) => el.dataset.id === "2")[0];
    expect(afterMsg1).toBe(msg1Node);
    expect(afterMsg2).toBeDefined();
    expect(afterMsg2!.textContent).toContain("Got it!");
  });

  test("expanding a long message only replaces that message node and preserves siblings", async () => {
    const { doc, fns } = loadThreadUi();
    const longBody = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
    fns.render(
      makeState({
        messages: [
          { id: 1, seq: 1, kind: "agent", from: "Acme Claude", side: "Acme", body: "Short first", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
          { id: 2, seq: 2, kind: "agent", from: "Vers Claude", side: "Vers", body: longBody, at: "2026-11-23T12:01:00Z", audience: "room", to: [] },
        ],
      }),
    );

    const log = doc.getElementById("log")!;
    const msg1Before = log.findAll((el) => el.dataset.id === "1")[0]!;
    const msg2Before = log.findAll((el) => el.dataset.id === "2")[0]!;
    const toggle = msg2Before.querySelector(".more")!;
    expect(toggle.textContent).toBe("Show all 20 lines");

    await toggle.click();
    expect(log.findAll((el) => el.dataset.id === "1")[0]).toBe(msg1Before);
    const msg2After = log.findAll((el) => el.dataset.id === "2")[0]!;
    expect(msg2After).not.toBe(msg2Before);
    expect(msg2After.querySelector(".more")!.textContent).toBe("Show less");
  });
});

describe("load earlier messages (has_more)", () => {
  test("shows Load earlier messages button, fetches /api/messages?before=..., prepends and preserves scroll position", async () => {
    const { doc, fetchCalls, fns } = loadThreadUi({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            { id: 10, seq: 10, kind: "agent", from: "Acme Claude", side: "Acme", body: "Earlier one", at: "2026-11-23T11:00:00Z", audience: "room", to: [] },
            { id: 11, seq: 11, kind: "agent", from: "Vers Claude", side: "Vers", body: "Earlier two", at: "2026-11-23T11:05:00Z", audience: "room", to: [] },
          ],
          has_more: false,
        }),
      }),
    });

    const state = makeState({
      has_more: true,
      messages: [
        { id: 12, seq: 12, kind: "agent", from: "Acme Claude", side: "Acme", body: "Newest", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
      ],
    });
    fns.render(state);

    const log = doc.getElementById("log")!;
    const existingNode = log.findAll((el) => el.dataset.id === "12")[0]!;
    const earlierBar = log.querySelector(".earlier");
    expect(earlierBar).not.toBeNull();
    const btn = earlierBar!.querySelector("button")!;
    expect(btn.textContent).toBe("Load earlier messages");

    log.scrollTop = 20;
    const heightBefore = log.scrollHeight;
    await btn.click();

    expect(fetchCalls[0]!.url).toBe("/api/messages?before=12&limit=200");
    const ids = log.findAll((el) => !!el.dataset.id).map((el) => el.dataset.id);
    expect(ids).toEqual(["10", "11", "12"]);
    // Existing node preserved, button hidden since has_more is now false, scroll adjusted by scrollHeight delta
    expect(log.findAll((el) => el.dataset.id === "12")[0]).toBe(existingNode);
    expect(log.querySelector(".earlier")).toBeNull();
    expect(log.scrollTop).toBe(20 + (log.scrollHeight - heightBefore));
  });
});

describe("display name, quick-reply, unread title, notifications, and notify_error", () => {
  test("saves human display name in localStorage, updates #sub, and sends from in POST /api/messages", async () => {
    const { doc, store, fetchCalls, fns } = loadThreadUi();
    fns.render(makeState());

    const input = doc.getElementById("humanName")!;
    input.value = "Alex";
    await input.dispatch("input");

    expect(store.get("parley_human_name")).toBe("Alex");
    expect(doc.getElementById("sub")!.textContent).toBe("You are Alex (Vers) on side Vers");

    doc.getElementById("body")!.value = "Looks good to ship";
    await doc.getElementById("composer")!.dispatch("submit");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("/api/messages");
    expect(JSON.parse(fetchCalls[0]!.init.body)).toEqual({ body: "Looks good to ship", from: "Alex" });
  });

  test("clicking a non-self speaker name sets #to, updates #toHint, and focuses #body", async () => {
    const { doc, fns } = loadThreadUi();
    fns.render(
      makeState({
        messages: [
          { id: 1, seq: 1, kind: "agent", from: "Acme Claude", side: "Acme", body: "Ping", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
          { id: 2, seq: 2, kind: "human", from: "Acme human", side: "Acme", body: "Hi", at: "2026-11-23T12:01:00Z", audience: "room", to: [] },
        ],
      }),
    );

    const log = doc.getElementById("log")!;
    const msg1Who = log.findAll((el) => el.dataset.id === "1")[0]!.querySelector(".who")!;
    await msg1Who.click();
    expect(doc.getElementById("to")!.value).toBe("agent:Acme Claude");
    expect(doc.getElementById("toHint")!.textContent).toContain("Acme Claude");
    expect(doc.activeElement).toBe(doc.getElementById("body"));

    const msg2Who = log.findAll((el) => el.dataset.id === "2")[0]!.querySelector(".who")!;
    await msg2Who.click();
    expect(doc.getElementById("to")!.value).toBe("side:Acme");
    expect(doc.getElementById("toHint")!.textContent).toContain("Acme");
  });

  test("tracks unread count in document.title when hidden, resets on visibilitychange, and fires desktop notifications", () => {
    const { doc, notifications, fns } = loadThreadUi({
      storage: { parley_desktop_notify: "1" },
      notificationPermission: "granted",
    });

    fns.render(makeState());
    expect(doc.title).toBe("Release Sync · Parley");

    doc.hidden = true;
    fns.render(
      makeState({
        version: 2,
        messages: [
          { id: 1, seq: 1, kind: "agent", from: "Acme Claude", side: "Acme", body: "Hello from Acme", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
          { id: 2, seq: 2, kind: "agent", from: "Acme Claude", side: "Acme", body: "Need Vers signoff", at: "2026-11-23T12:02:00Z", audience: "direct", to: ["Vers"] },
        ],
      }),
    );

    expect(doc.title).toBe("(1) Release Sync · Parley");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.body).toContain("Acme Claude");

    // Pending review message & newly flagged unowned during slim poll also notify while hidden
    fns.render(
      makeState({
        version: 3,
        messages: [
          { id: 1, seq: 1, kind: "agent", from: "Acme Claude", side: "Acme", body: "Hello from Acme", at: "2026-11-23T12:00:00Z", audience: "room", to: [] },
          { id: 2, seq: 2, kind: "agent", from: "Acme Claude", side: "Acme", body: "Need Vers signoff", at: "2026-11-23T12:02:00Z", audience: "direct", to: ["Vers"] },
        ],
        pending: [
          { id: 99, seq: null, kind: "agent", from: "Vers Claude", side: "Vers", body: "Ready to deploy", at: "2026-11-23T12:03:00Z", audience: "room", to: [] },
        ],
      }),
    );
    expect(doc.title).toBe("(2) Release Sync · Parley");
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.body).toContain("Waiting for your review");

    fns.applySlim({
      unchanged: true,
      version: 3,
      participants: makeState().participants,
      unowned: { seqs: [1], from: "Acme Claude", since: "2026-11-23T12:00:00Z", read_by: ["Vers Claude"] },
    });
    expect(notifications).toHaveLength(3);
    expect(notifications[2]!.body).toContain("Unowned message");

    doc.hidden = false;
    doc.dispatch("visibilitychange");
    expect(doc.title).toBe("Release Sync · Parley");
  });

  test("desktop notifications toggle requests permission and persists preference", async () => {
    const { doc, store } = loadThreadUi({ notificationPermission: "default", requestPermissionResult: "granted" });
    const cb = doc.getElementById("desktopNotify")!;
    expect(cb.checked).toBe(false);
    cb.checked = true;
    await cb.dispatch("change");
    expect(cb.checked).toBe(true);
    expect(store.get("parley_desktop_notify")).toBe("1");
  });

  test("renders state.notify_error under #notifyForm and hides it when null", () => {
    const { doc, fns } = loadThreadUi();
    fns.render(makeState({ notify_error: { at: "2026-11-23T12:05:00Z", message: "Webhook returned 502" } }));
    const errEl = doc.getElementById("notifyError")!;
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent).toContain("Last delivery failed");
    expect(errEl.textContent).toContain("Webhook returned 502");

    fns.render(makeState({ version: 2, notify_error: null }));
    expect(errEl.hidden).toBe(true);
    expect(errEl.textContent).toBe("");
  });

  test("Test button calls /api/settings/test-notify and reports delivery", async () => {
    const calls: { url: string; body?: string }[] = [];
    const { doc, fns } = loadThreadUi({
      fetchImpl: async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body });
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 200 }) };
      },
    });
    fns.render(makeState());
    doc.getElementById("notifyUrl")!.value = "https://hooks.slack.com/services/T1/B1/abc";
    await doc.getElementById("testNotifyBtn")!.onclick!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/settings/test-notify");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ notify_url: "https://hooks.slack.com/services/T1/B1/abc" });
    expect(doc.getElementById("notifyOk")!.hidden).toBe(false);
    expect(doc.getElementById("notifyOk")!.textContent).toContain("delivered");
  });

  test("home page supports adding extra sides and copy buttons for links", () => {
    expect(homePage).toContain('id="addSide"');
    expect(homePage).toContain("MAX_SIDES = 6");
    expect(homePage).toContain("Copy link");
    expect(homePage).toContain("Copy join command");
  });
});
