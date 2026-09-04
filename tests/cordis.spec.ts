import { Context } from "cordis";
import { describe, expect, test } from "vitest";
import SocialService from "cordis-plugin-social";
import SocialBrowserService from "cordis-plugin-social-browser";
import xPlugin from "cordis-plugin-social-x";

class FakeBrowserService extends SocialBrowserService {
  constructor(ctx: Context) { super(ctx); }
  async acquire(): Promise<never> { throw new Error("not used by lifecycle test"); }
}

describe("Cordis plugin integration", () => {
  test("reactively activates X after required services appear and reverses on dispose", async () => {
    const root = new Context();
    const xFiber = root.plugin(xPlugin, { accountId: "personal" });
    expect(root.registry.size).toBe(1);
    const socialFiber = root.plugin(SocialService);
    const browserFiber = root.plugin(FakeBrowserService);
    await Promise.all([xFiber, socialFiber, browserFiber]);
    expect(root.social.platforms()).toEqual([{
      platform: "x",
      accountId: "personal",
      capabilities: ["auth.login", "auth.status", "post.create", "post.quote", "post.reply"],
    }]);
    await xFiber.dispose();
    expect(root.social.platforms()).toEqual([]);
    await root.fiber.dispose();
  });
});
