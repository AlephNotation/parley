import { describe, expect, test } from "bun:test";
import { describeFindings, findSecrets } from "../src/secrets";
import { startServer } from "./helpers";

// Fake credentials are assembled at run time so this file holds no literal secret shapes.
const r = (n: number, chars = "aB3dE5gH7jK9mN1pQ2sT4vW6xY8z") => Array.from({ length: n }, (_, i) => chars[(i * 7) % chars.length]).join("");
const FAKES: [string, string][] = [
  ["a private key block", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ") + "\n" + r(64) + "\n-----END OPENSSH PRIVATE KEY-----"],
  ["an AWS access key id", "AK" + "IA" + r(16, "ABCDEFGHJKLMNPQRSTUVWXYZ234567")],
  ["an AWS secret access key", "aws_secret_access_key = " + r(40)],
  ["a GitHub token", "gh" + "p_" + r(36)],
  ["a GitLab token", "gl" + "pat-" + r(20)],
  ["a Slack token", "xo" + "xb-" + "1234567890-" + r(24)],
  ["a Slack webhook URL", "https://hooks.slack.com/services/" + "T" + r(8, "ABCDEFGH12345") + "/B" + r(8, "ABCDEFGH12345") + "/" + r(24)],
  ["a Stripe key", "sk" + "_live_" + r(24)],
  ["an Anthropic API key", "sk" + "-ant-" + "api03-" + r(40)],
  ["an OpenAI API key", "sk" + "-proj-" + r(40)],
  ["a Google API key", "AI" + "za" + r(35)],
  ["a Parley agent or room token", "p" + "m_" + r(32)],
  ["a JSON web token", "ey" + "J" + r(20) + ".ey" + "J" + r(20) + "." + r(30)],
  ["a bearer token", "Authorization: Bearer " + r(40)],
];

describe("secret scanning", () => {
  test("each credential shape is found, by kind and line", () => {
    for (const [kind, secret] of FAKES) {
      expect([kind, findSecrets(`Here you go:\n\n${secret}\nthanks`)]).toEqual([kind, [{ kind, line: 3 }]]);
    }
  });

  test("ordinary technical text is not flagged", () => {
    for (const text of [
      "Send the header as `authorization: Bearer <token>`, or Bearer $PARLEY_TOKEN in a script.",
      "The task-0123456789abcdef0123456789abcdef id and the desk-abcdefabcdefabcdefabcdefabcdefab name are fine.",
      'The test uses "pm_x" and ph_short as fake tokens.',
      "sk-short is not a key, and neither is AKIA on its own.",
      "Mailbox vers-claude-9d4096 posted #42 at 05:31Z; commit 4bee3f423601edf8d136bc0904385fae384fbece.",
      "SHA-256 7bad21f1b5d5e75b8cc7c0f430256f18c9650fd94e683c63caa5d150cee6abec matches.",
      "-----BEGIN PUBLIC KEY----- is safe to share.",
    ]) {
      expect([text, findSecrets(text)]).toEqual([text, []]);
    }
  });

  test("the description names kinds and lines only", () => {
    const findings = findSecrets(`${FAKES[3]![1]}\nok\n${FAKES[7]![1]}`);
    expect(describeFindings(findings)).toBe("a GitHub token on line 1 and a Stripe key on line 3");
  });
});

describe("posting with secret scanning", () => {
  test("an agent post with a credential is refused with what matched, and the credential is neither echoed nor logged", async () => {
    const s = startServer();
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      const t = await s.setup(false);
      const secret = FAKES[3]![1];
      const res = await s.send(t.vers.token, t.id, `Use this token:\n${secret}`);
      expect(res.status).toBe(422);
      expect(res.data.error.code).toBe("secret_detected");
      expect(res.data.error.message).toBe("Not posted: the message looks like it contains a GitHub token on line 2.");
      expect(res.data.error.hint).toContain("<redacted>");
      expect(JSON.stringify(res.data)).not.toContain(secret);
      expect(errors.join("\n")).not.toContain(secret);
      // Nothing reached the room.
      const history = await s.call(t.acme.token, "GET", `/api/threads/${t.id}/messages`);
      expect(JSON.stringify(history.data)).not.toContain(secret);
      // Rephrased, it goes through.
      expect((await s.send(t.vers.token, t.id, "Use the GitHub token I set in CI as GH_TOKEN.")).status).toBe(201);
    } finally {
      console.error = log;
      await s.stop();
    }
  });

  test("humans are not scanned, and the scan can be turned off", async () => {
    const s = startServer();
    const off = startServer({ secretScan: false });
    try {
      const t = await s.setup(false);
      expect((await s.call(t.versHuman, "POST", "/api/messages", { body: FAKES[7]![1] })).status).toBe(201);
      const u = await off.setup(false);
      expect((await off.send(u.vers.token, u.id, FAKES[7]![1])).status).toBe(201);
    } finally {
      await s.stop();
      await off.stop();
    }
  });
});
