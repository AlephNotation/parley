// The Slack side of a room mirror: request signing, text conversion and the Web API call.
// Each side of a room brings its own Slack app, so nothing here is shared between sides.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects requests older than this, so a captured request cannot be replayed later. */
const MAX_SKEW_SECONDS = 300;

/** The `v0=` signature Slack sends for a request body, from the app's signing secret. */
export function slackSignature(secret: string, timestamp: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

/** True when a request really came from the Slack app that holds `secret`, and recently. */
export function verifySlackRequest(secret: string, headers: Headers, body: string, now = Date.now()): boolean {
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const given = Buffer.from(headers.get("x-slack-signature") ?? "");
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(slackSignature(secret, timestamp, body));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Makes room text safe to show in Slack. Escaping the three control characters is what stops
 * text written by another organisation from pinging a channel (`<!channel>`), mentioning a user
 * or disguising a link (`<https://evil|your bank>`).
 */
export function toSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Turns what Slack sends for a typed message back into plain text. */
export function fromSlackText(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (_all, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A Slack Web API call that Slack answered with `ok: false`, or that never got an answer. */
export class SlackError extends Error {
  constructor(public code: string) {
    super(`Slack said: ${code}`);
  }
}

/** Calls one Slack Web API method with a bot token and returns its result. */
export async function slackCall<T = Record<string, any>>(api: string, token: string, method: string, params: Record<string, unknown>): Promise<T> {
  let data: any;
  try {
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
    data = await res.json();
  } catch (err) {
    throw new SlackError(`unreachable (${(err as Error).message})`);
  }
  if (!data?.ok) throw new SlackError(typeof data?.error === "string" ? data.error : "unknown_error");
  return data as T;
}

/** The app manifest a side pastes into Slack to create its own app for one room. */
export function slackManifest(roomTitle: string, sideName: string, eventsUrl: string) {
  return {
    display_information: { name: `Parley: ${roomTitle}`.slice(0, 35), description: `Mirrors a Parley room for ${sideName}`.slice(0, 140) },
    features: { bot_user: { display_name: "Parley", always_online: false } },
    oauth_config: { scopes: { bot: ["chat:write", "channels:history", "groups:history", "users:read"] } },
    settings: {
      event_subscriptions: { request_url: eventsUrl, bot_events: ["message.channels", "message.groups"] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
