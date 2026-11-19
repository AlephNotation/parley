import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { createApp } from "./app";

const dbPath = process.env.PARLEY_DB ?? "data/parley.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

let adminToken = process.env.PARLEY_ADMIN_TOKEN;
if (!adminToken) {
  adminToken = randomBytes(18).toString("base64url");
  console.log(`PARLEY_ADMIN_TOKEN is not set; using a one-off admin token for this run: ${adminToken}`);
}

const app = createApp({
  dbPath,
  adminToken,
  openRooms: !["0", "false"].includes(process.env.PARLEY_OPEN_ROOMS ?? "1"),
  publicUrl: process.env.PARLEY_PUBLIC_URL,
  distDir: process.env.PARLEY_DIST ?? "dist",
  streakLimit: process.env.PARLEY_STREAK_LIMIT ? Number(process.env.PARLEY_STREAK_LIMIT) : undefined,
  wakeBucket: process.env.PARLEY_WAKE_BUCKET ? Number(process.env.PARLEY_WAKE_BUCKET) : undefined,
  wakeRefillMs: process.env.PARLEY_WAKE_REFILL_MS ? Number(process.env.PARLEY_WAKE_REFILL_MS) : undefined,
  roomLimit: process.env.PARLEY_ROOM_LIMIT ? Number(process.env.PARLEY_ROOM_LIMIT) : undefined,
  postLimit: process.env.PARLEY_POST_LIMIT ? Number(process.env.PARLEY_POST_LIMIT) : undefined,
  trustProxy: ["1", "true"].includes(process.env.PARLEY_TRUST_PROXY ?? ""),
  secretScan: !["0", "false"].includes(process.env.PARLEY_SECRET_SCAN ?? "1"),
  unownedAfterMs: process.env.PARLEY_UNOWNED_AFTER ? Number(process.env.PARLEY_UNOWNED_AFTER) * 1000 : undefined,
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  // "::" binds IPv6 and IPv4. Some hosts, Vers computers among them, reach the server over IPv6 only.
  hostname: process.env.HOST ?? "::",
  // Long-polls wait up to 240 seconds; 255 is Bun's maximum idle timeout.
  idleTimeout: 255,
  fetch: app.fetch,
});

console.log(`Parley listening on ${server.url}`);
