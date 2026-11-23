import { describe, expect, test } from "bun:test";
import net from "node:net";
import { isPublicAddress, sendWebhook } from "../src/webhook";
import { startServer } from "./helpers";

describe("webhook address checks", () => {
  test("private, loopback, link-local and other non-public addresses are refused", () => {
    for (const address of [
      "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fec0::1", "fd12:3456::1", "fc00::1", "ff02::1",
      "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:0a00:0001", "::ffff:169.254.169.254",
      "::127.0.0.1", "::10.0.0.1", "::0a00:0001",
      "64:ff9b::a00:1", "64:ff9b:1::1", "64:ff9b:1::8.8.8.8", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2002:c0a8:101::1", "not an address",
    ]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:10::6814:179a", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect([address, isPublicAddress(address)]).toEqual([address, true]);
    }
  });

  test("non-http/https webhook protocols are rejected", async () => {
    await expect(sendWebhook("file:///etc/passwd", {}, { allowPrivate: true })).rejects.toThrow("unsupported webhook protocol");
    await expect(sendWebhook("ftp://93.184.216.34/hook", {})).rejects.toThrow("unsupported webhook protocol");
  });

  test("a slow-drip response hits the overall deadline timer", async () => {
    const sockets = new Set<net.Socket>();
    const timers = new Set<ReturnType<typeof setInterval>>();
    const srv = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("data", () => {
        socket.write("HTTP/1.1 100 Continue\r\n\r\n");
        const t = setInterval(() => {
          if (!socket.destroyed) socket.write("HTTP/1.1 100 Continue\r\n\r\n");
        }, 40);
        timers.add(t);
        socket.on("close", () => {
          clearInterval(t);
          timers.delete(t);
        });
      });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const began = Date.now();
      await expect(sendWebhook(`http://127.0.0.1:${port}/slow`, { text: "hi" }, { allowPrivate: true, timeoutMs: 150 })).rejects.toThrow("timed out");
      expect(Date.now() - began).toBeLessThan(1000);
    } finally {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  test("a host is refused if any address it resolves to is not public", async () => {
    const resolve = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];
    await expect(sendWebhook("https://hooks.example.test/x", {}, { resolve })).rejects.toThrow(
      "hooks.example.test resolves to 10.0.0.7, which is not a public address; not sending",
    );
    await expect(sendWebhook("https://127.0.0.1/x", {})).rejects.toThrow("not a public address");
  });

  test("the request goes to the address that was checked, not to a second lookup", async () => {
    const hits: string[] = [];
    const hook = Bun.serve({ port: 0, fetch: async (req) => (hits.push(`${req.headers.get("host")} ${await req.text()}`), new Response("ok")) });
    try {
      // .test never resolves in real DNS, so a delivery proves the pinned address was used.
      const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
      const status = await sendWebhook(`http://hooks.example.test:${hook.port}/hook`, { text: "hi" }, { allowPrivate: true, resolve });
      expect(status).toBe(200);
      expect(hits).toEqual([`hooks.example.test:${hook.port} {"text":"hi"}`]);
    } finally {
      hook.stop(true);
    }
  });
});

describe("webhook sending from the server", () => {
  test("a webhook host that rebinds to a private address after it was saved is not called", async () => {
    let answer = "93.184.216.34";
    const resolved: string[] = [];
    const strict = startServer({
      allowPrivateWebhooks: false,
      resolveHost: async (host) => (resolved.push(host), [{ address: answer, family: 4 }]),
    });
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const t = await strict.setup(false);
      expect((await strict.call(t.acmeHuman, "POST", "/api/settings", { notify_url: "https://hooks.example.test/x" })).status).toBe(200);
      // Saved while public; now it points inside the network.
      answer = "169.254.169.254";
      await strict.send(t.vers.token, t.id, "nobody home?");
      await strict.app.sweep();
      expect(resolved).toEqual(["hooks.example.test"]);
      expect(errors.some((e) => e.includes("hooks.example.test resolves to 169.254.169.254, which is not a public address; not sending"))).toBe(true);
      const state = (await strict.call(t.acmeHuman, "GET", "/api/state")).data;
      expect(state.notify_error.message).toContain("169.254.169.254");
      expect(Date.parse(state.notify_error.at)).toBeGreaterThan(0);
      // Updating or clearing notify_url clears the recorded error.
      await strict.call(t.acmeHuman, "POST", "/api/settings", { notify_url: null });
      expect((await strict.call(t.acmeHuman, "GET", "/api/state")).data.notify_error).toBeNull();
    } finally {
      console.error = log;
      await strict.stop();
    }
  });

  test("notify_error records non-2xx responses and clears on a subsequent 2xx delivery", async () => {
    let status = 502;
    const hook = Bun.serve({ port: 0, fetch: () => new Response("err", { status }) });
    const srv = startServer();
    const log = console.error;
    console.error = () => {};
    try {
      const t = await srv.setup(false);
      await srv.call(t.acmeHuman, "POST", "/api/settings", { notify_url: hook.url.origin + "/hook" });
      await srv.send(t.vers.token, t.id, "first");
      await srv.app.sweep();
      expect((await srv.call(t.acmeHuman, "GET", "/api/state")).data.notify_error.message).toBe("HTTP 502");
      status = 200;
      await srv.send(t.vers.token, t.id, "second");
      await srv.app.sweep();
      expect((await srv.call(t.acmeHuman, "GET", "/api/state")).data.notify_error).toBeNull();
    } finally {
      console.error = log;
      hook.stop(true);
      await srv.stop();
    }
  });
});
