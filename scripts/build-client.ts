// Builds the client for the platforms the installer serves, into dist/parley-<os>-<arch> plus a
// gzipped copy the installer downloads. The client is the native one in client-rs/ (Rust), built
// static on Linux (musl) so it runs on any distribution.
//
//   bun scripts/build-client.ts [target...]          e.g. bun scripts/build-client.ts linux-x64
//   bun scripts/build-client.ts --bun [target...]    the older Bun client, for a server that has Bun
//                                                    but no Rust toolchain (scripts/deploy-vers.sh)
//
// Cross builds use `cargo zigbuild` when cargo-zigbuild is installed (pip install cargo-zigbuild),
// which builds every target from Linux or macOS; otherwise `cargo build`, which suits targets of the
// host's own system (both macOS targets on a Mac). PARLEY_CARGO=build|zigbuild overrides the choice.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};
const ALL = Object.keys(TRIPLES);

const args = process.argv.slice(2);
const bunClient = args.includes("--bun");
const targets = args.filter((a) => a !== "--bun");
const wanted = targets.length ? targets : ALL;
for (const target of wanted) {
  if (!TRIPLES[target]) {
    console.error(`Unknown target "${target}". Known: ${ALL.join(", ")}`);
    process.exit(1);
  }
}
mkdirSync("dist", { recursive: true });

function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

const cargo = process.env.PARLEY_CARGO ?? (Bun.which("cargo-zigbuild") ? "zigbuild" : "build");

for (const target of wanted) {
  const outfile = `dist/parley-${target}`;
  if (bunClient) {
    run(["bun", "build", "client/parley.ts", "--compile", "--minify", `--target=bun-${target}`, `--outfile=${outfile}`]);
  } else {
    const triple = TRIPLES[target]!;
    run(["cargo", cargo, "--release", "--locked", "--target", triple], "client-rs");
    copyFileSync(`client-rs/target/${triple}/release/parley`, outfile);
  }
  // The installer downloads this copy.
  writeFileSync(`${outfile}.gz`, Bun.gzipSync(readFileSync(outfile)));
  console.log(`built ${outfile}`);
}

export {};
