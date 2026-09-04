import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts");
const packageDirs = ["core", "browser", "local-browser", "profilefleet", "x", "tools"];
const windowsShell = process.platform === "win32";
const pnpm = windowsShell ? "pnpm.cmd" : "pnpm";
const npm = windowsShell ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", shell: windowsShell });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
for (const directory of packageDirs) {
  run(pnpm, ["pack", "--pack-destination", artifacts], join(root, "packages", directory));
}

const tarballs = (await readdir(artifacts))
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => join(artifacts, name));
if (tarballs.length !== packageDirs.length) {
  throw new Error(`Expected ${packageDirs.length} tarballs, found ${tarballs.length}`);
}

for (const tarball of tarballs) {
  const listing = run("tar", ["-tzf", tarball], root);
  if (!listing.includes("package/lib/index.js") || !listing.includes("package/lib/index.d.ts")) {
    throw new Error(`${tarball} is missing its compiled package entry`);
  }
}

const consumer = await mkdtemp(join(tmpdir(), "cordis-social-consumer-"));
try {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(npm, [
    "install",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefer-offline",
    ...tarballs,
    "cordis@4.0.0-rc.9",
    "playwright-core@1.62.1",
    "https://github.com/enginefuture/profilefleet/releases/download/v0.1.0/profilefleet-0.1.0.tgz",
  ], consumer);
  await writeFile(join(consumer, "smoke.mjs"), `
    const [core, browser, local, profilefleet, x, tools] = await Promise.all([
      import("cordis-plugin-social"),
      import("cordis-plugin-social-browser"),
      import("cordis-plugin-social-browser-local"),
      import("cordis-plugin-social-profilefleet"),
      import("cordis-plugin-social-x"),
      import("cordis-plugin-social-tools"),
    ]);
    if (!core.SocialService || !browser.SocialBrowserService || !local.LocalBrowserService ||
        !profilefleet.ProfileFleetBrowserService || !x.apply || !tools.SocialToolsService) {
      throw new Error("A documented package export is missing");
    }
  `);
  run(process.execPath, [join(consumer, "smoke.mjs")], consumer);
  const names = [];
  for (const tarball of tarballs) {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(tarball));
    names.push(`${tarball.split(/[\\/]/).at(-1)} (${stat.size} bytes)`);
  }
  console.log(`Package smoke passed:\n${names.join("\n")}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
