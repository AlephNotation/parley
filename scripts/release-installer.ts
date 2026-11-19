// Prints the installer published with a release: `bun scripts/release-installer.ts <owner/repo> <tag>`.
// It installs that release's client and records no server, so it can be fetched from GitHub directly.
import { releaseInstaller } from "../src/install";

const [repo, version] = process.argv.slice(2);
if (!repo || !version) {
  console.error("usage: bun scripts/release-installer.ts <owner/repo> <tag>");
  process.exit(1);
}
process.stdout.write(releaseInstaller({ repo, version }));
