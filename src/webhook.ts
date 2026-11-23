// Delivers notification webhooks without trusting DNS twice. A hostname that looked public when the
// webhook was saved can later resolve to a private address (DNS rebinding), so the host is resolved
// again at send time, every address is checked, and the connection goes to the address that was
// checked rather than to whatever a second lookup returns.
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** Addresses a webhook must never reach: private, loopback, link-local, and other non-public ranges. */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** The IPv4 address carried inside an IPv4-mapped/compatible, NAT64 (64:ff9b::/96), or 6to4 (2002::/16) IPv6 address, if any. */
function embeddedIpv4(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0]!;
  // A trailing dotted IPv4 part becomes two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True when an IP address is on the public internet, so a webhook may be sent to it. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    if (blocked.check(address, "ipv6")) return false;
    const inner = embeddedIpv4(address);
    return inner === null || !blocked.check(inner, "ipv4");
  }
  return false;
}

/**
 * POSTs `body` as JSON to `rawUrl` and returns the HTTP status. Resolves the host, refuses if any
 * address is not public (unless `allowPrivate`), then connects to the first checked address while
 * TLS still verifies the certificate against the hostname. Redirects are not followed.
 */
export async function sendWebhook(
  rawUrl: string,
  body: unknown,
  opts: { allowPrivate?: boolean; resolve?: Resolver; timeoutMs?: number } = {},
): Promise<number> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported webhook protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await (opts.resolve ?? systemResolver)(host);
  if (addresses.length === 0) throw new Error(`${host} did not resolve`);
  if (!opts.allowPrivate) {
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) throw new Error(`${host} resolves to ${bad.address}, which is not a public address; not sending`);
  }
  const pinned = addresses[0]!;
  const payload = JSON.stringify(body);
  const client = url.protocol === "https:" ? https : http;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn();
    };
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
        // Connect to the address that was checked, never to a fresh lookup.
        lookup: (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) =>
          options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      },
      (res) => {
        res.resume();
        finish(() => resolve(res.statusCode ?? 0));
      },
    );
    // Overall deadline in addition to socket idle timeout, so a slow-drip response cannot hang forever.
    deadline = setTimeout(() => {
      const err = new Error("timed out");
      req.destroy(err);
      finish(() => reject(err));
    }, timeoutMs);
    req.on("error", (err) => finish(() => reject(err)));
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.end(payload);
  });
}
