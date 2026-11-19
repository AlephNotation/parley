import { describe, expect, test } from "bun:test";
import { isPublicAddress, sendWebhook } from "../src/webhook";
import { startServer } from "./helpers";

describe("webhook address checks", () => {
  test("private, loopback, link-local and other non-public addresses are refused", () => {
    for (const address of [
      "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd12:3456::1", "fc00::1", "ff02::1",
      "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1", "not an address",
    ]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:10::6814:179a", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect([address, isPublicAddress(address)]).toEqual([address, true]);
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
    } finally {
      console.error = log;
      await strict.stop();
    }
  });
});
