import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const notBuilt = () =>
  Response.json(
    {
      error: {
        code: "client_not_built",
        message: "This server has no client binaries to offer.",
        hint: "The operator must run `bun run build:client`. Until then, use the no-install instructions from your invite.",
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

/** A POSIX installer that downloads the right binary and checks it against the checksum baked in here. */
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
