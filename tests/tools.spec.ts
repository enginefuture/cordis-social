import { Context } from "cordis";
import { describe, expect, test } from "vitest";
import SocialService, { type SocialPlatformAdapter } from "cordis-plugin-social";
import SocialToolsService from "cordis-plugin-social-tools";

describe("SocialToolsService", () => {
  test("exposes host-neutral prepare and publish tools", async () => {
    const root = new Context();
    await root.plugin(SocialService);
    await root.plugin(SocialToolsService);
    const adapter: SocialPlatformAdapter = {
      platform: "test",
      accountId: "default",
      capabilities: new Set(["auth.status", "post.create"]),
      authStatus: async () => ({ platform: "test", accountId: "default", state: "authenticated" }),
      preparePost: async (input) => ({
        preview: { platform: "test", accountId: "default", kind: "post", text: input.text, media: [] },
        publish: async () => ({ platform: "test", accountId: "default", postId: "published", publishedAt: new Date().toISOString() }),
        dispose: () => undefined,
      }),
    };
    await root.inject(["social"], (ctx) => ctx.social.register(adapter));
    const names = root.socialTools.list().map((tool) => tool.name);
    expect(names).toContain("social_prepare_post");
    expect(names).toContain("social_publish_post");
    const draft = await root.socialTools.execute("social_prepare_post", {
      platform: "test",
      text: "prepared by a host tool",
    }) as { id: string; confirmationToken: string };
    const result = await root.socialTools.execute("social_publish_post", draft) as { postId: string };
    expect(result.postId).toBe("published");
    await root.fiber.dispose();
  });
});
