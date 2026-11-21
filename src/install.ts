import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The client version this server's source carries; releases are tagged v<version>. */
export const CLIENT_VERSION = /^const VERSION = "([^"]+)";$/m.exec(await Bun.file(new URL("../client/parley.ts", import.meta.url)).text())![1]!;

export interface ClientRelease {
  /** GitHub repository the release lives in, as owner/name. */
  repo: string;
  /** Release tag, e.g. v0.5.0. */
  version: string;
  /** Where the release's files are downloaded from. Defaults to the GitHub release; tests point it elsewhere. */
  base?: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A POSIX installer that downloads the client from a GitHub release and checks it against the
 * release's SHA256SUMS, so the binary is only as trustworthy as the repository's release, not as the
 * server that handed out the script. With `gh` signed in it also verifies the build provenance
 * attestation. `server`, when given, is recorded so `parley new` knows where to create rooms.
 * The release workflow publishes this same script, without a server, as the release's install.sh.
 */
export function releaseInstaller(release: ClientRelease, server?: string): string {
  const base = release.base ?? `https://github.com/${release.repo}/releases/download/${release.version}`;
  return `#!/bin/sh
# Installs the Parley client ${release.version} from ${release.repo}'s GitHub release to ~/.local/bin/parley
# (override with PARLEY_BIN_DIR). The binary is checked against the release's SHA256SUMS.
set -eu
repo=${shellQuote(release.repo)}
version=${shellQuote(release.version)}
base=${shellQuote(base)}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
name="parley-$os-$arch"
dir="\${PARLEY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo "parley: could not fetch SHA256SUMS for $version from $repo" >&2; exit 1; }
want=$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/SHA256SUMS")
if [ -z "$want" ]; then echo "parley: release $version has no client build for $os/$arch" >&2; exit 1; fi
echo "Downloading the Parley client $version from $repo..."
if [ -t 2 ]; then progress="--progress-bar"; else progress="-sS"; fi
curl -fL $progress "$base/$name.gz" -o "$tmp/$name.gz"
gunzip -c "$tmp/$name.gz" > "$tmp/$name"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then echo "parley: checksum mismatch against the release's SHA256SUMS, refusing to install" >&2; exit 1; fi
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh attestation verify "$tmp/$name" --repo "$repo" >/dev/null 2>&1; then
    echo "Build provenance verified: built by $repo's release workflow."
  else
    echo "parley: the build provenance attestation did not verify against $repo, refusing to install" >&2; exit 1
  fi
else
  echo "Checksum verified against the $version release. To also check build provenance: gh attestation verify $dir/parley --repo $repo"
fi
chmod +x "$tmp/$name"
mv "$tmp/$name" "$dir/parley"
echo "Installed $dir/parley"
${
  server
    ? `# Remembered so \`parley new\` knows which server to create rooms on.
home="\${PARLEY_HOME:-$HOME/.parley}"
mkdir -p "$home" && chmod 700 "$home" && echo ${shellQuote(server)} > "$home/server"
`
    : ""
}case ":$PATH:" in *":$dir:"*) ;; *) echo "Note: $dir is not on your PATH. Add it, or call $dir/parley directly." ;; esac
`;
}

/** The installer a server hands out: from the release, or, when the operator opted in, its own build. */
export async function serveInstaller(base: string, opts: { release: ClientRelease; selfHosted?: boolean; distDir?: string }): Promise<Response> {
  if (opts.selfHosted) return installScript(base, opts.distDir);
  return new Response(releaseInstaller(opts.release, base), {
    headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" },
  });
}

const notBuilt = () =>
  Response.json(
    {
      error: {
        code: "client_not_built",
        message: "This server has no client binaries to offer.",
        hint: "The operator must run `bun run build:client` (needs Rust and cargo-zigbuild; `--bun` builds the Bun client instead), or put a release's binaries in PARLEY_DIST. Until then, use the no-install instructions from your invite.",
      },
    },
    { status: 404 },
  );

function binaries(distDir?: string): string[] {
  if (!distDir || !existsSync(distDir)) return [];
  return readdirSync(distDir).filter((name) => /^parley-[a-z0-9]+-[a-z0-9]+$/.test(name));
}

/** Serves a client binary, or its gzipped copy when asked for `<name>.gz` and the build produced one. */
export function clientDownload(name: string, distDir?: string): Response {
  const binary = name.replace(/\.gz$/, "");
  if (!binaries(distDir).includes(binary) || !existsSync(join(distDir!, name))) return notBuilt();
  return new Response(Bun.file(join(distDir!, name)), {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}

/**
 * The self-hosted installer: downloads this server's own build and checks it against a checksum this
 * same server computed. It catches corruption, not a compromised server, and says so when it runs.
 * Only served when the operator sets PARLEY_SELF_HOSTED_CLIENT=1.
 */
export async function installScript(base: string, distDir?: string): Promise<Response> {
  const names = binaries(distDir);
  if (names.length === 0) return notBuilt();
  const sums: string[] = [];
  for (const name of names) {
    const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(join(distDir!, name)).arrayBuffer()).digest("hex");
    // The gzipped copy is about a third of the size. The checksum is always of the binary itself.
    const gz = join(distDir!, `${name}.gz`);
    const file = existsSync(gz) ? `${name}.gz` : name;
    const mb = Math.max(1, Math.round(statSync(join(distDir!, file)).size / 1e6));
    sums.push(`    ${name}) want=${hash}; file=${file}; mb=${mb} ;;`);
  }
  const script = `#!/bin/sh
# Installs the Parley client to ~/.local/bin/parley (override with PARLEY_BIN_DIR).
set -eu
echo "parley: warning: this client is built and checksummed by ${base} itself, so it is only as trustworthy as that server." >&2
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
name="parley-$os-$arch"
case "$name" in
${sums.join("\n")}
    *) echo "parley: no client build for $os/$arch on this server" >&2; exit 1 ;;
esac
dir="\${PARLEY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "Downloading the Parley client ($mb MB)..."
if [ -t 2 ]; then progress="--progress-bar"; else progress="-sS"; fi
curl -fL $progress "${base}/dl/$file" -o "$tmp"
case "$file" in *.gz) gunzip -c "$tmp" > "$tmp.bin" && mv "$tmp.bin" "$tmp" ;; esac
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then echo "parley: checksum mismatch, refusing to install" >&2; exit 1; fi
chmod +x "$tmp"
mv "$tmp" "$dir/parley"
trap - EXIT
echo "Installed $dir/parley"
# Remembered so \`parley new\` knows which server to create rooms on.
home="\${PARLEY_HOME:-$HOME/.parley}"
mkdir -p "$home" && chmod 700 "$home" && echo "${base}" > "$home/server"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Note: $dir is not on your PATH. Add it, or call $dir/parley directly." ;; esac
`;
  return new Response(script, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
}
