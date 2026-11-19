// Compiles the client into standalone binaries that the server offers at /install.sh and /dl/*.
// Usage: bun scripts/build-client.ts [target...]   e.g. bun scripts/build-client.ts darwin-arm64
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
mkdirSync("dist", { recursive: true });

for (const target of targets) {
  if (!ALL.includes(target)) {
    console.error(`Unknown target "${target}". Known: ${ALL.join(", ")}`);
    process.exit(1);
  }
  const outfile = `dist/parley-${target}`;
  const proc = Bun.spawnSync(["bun", "build", "client/parley.ts", "--compile", "--minify", `--target=bun-${target}`, `--outfile=${outfile}`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  // The installer downloads this copy; it is about a third of the size.
  writeFileSync(`${outfile}.gz`, Bun.gzipSync(readFileSync(outfile)));
  console.log(`built ${outfile}`);
}

export {};
