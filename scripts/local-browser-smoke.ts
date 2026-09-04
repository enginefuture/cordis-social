import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import LocalBrowserService from "cordis-plugin-social-browser-local";

const profilesDir = await mkdtemp(join(tmpdir(), "cordis-social-browser-"));
const originServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Cordis Social smoke</title><main>ready</main>");
});
await new Promise<void>((ready) => originServer.listen(0, "127.0.0.1", ready));
const address = originServer.address();
if (!address || typeof address === "string") throw new Error("Unable to allocate local test origin");
const origin = `http://127.0.0.1:${address.port}`;
const root = new Context();

try {
  await root.plugin(LocalBrowserService, {
    browser: "auto",
    profilesDir,
    profiles: { "test:default": "persistence-smoke" },
  });
  await root.inject(["socialBrowser"], async (ctx) => {
    const first = await ctx.socialBrowser.acquire({
      platform: "test",
      accountId: "default",
      purpose: "read",
      initialUrl: origin,
      ttlSeconds: 120,
    });
    await first.page.evaluate(() => localStorage.setItem("cordis-social", "persisted"));
    await first.release();

    const second = await ctx.socialBrowser.acquire({
      platform: "test",
      accountId: "default",
      purpose: "read",
      initialUrl: origin,
      ttlSeconds: 120,
    });
    const persisted = await second.page.evaluate(() => localStorage.getItem("cordis-social"));
    await second.release();
    if (persisted !== "persisted") throw new Error("Local browser profile did not persist storage");
  });
  console.log("Local browser smoke passed: Cordis injection, CDP, release, and persistent profile");
} finally {
  await root.fiber.dispose();
  await new Promise<void>((done) => originServer.close(() => done()));
  await rm(profilesDir, { recursive: true, force: true });
}
