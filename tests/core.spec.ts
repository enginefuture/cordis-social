import { Context } from "cordis";
import { describe, expect, test, vi } from "vitest";
import SocialService, {
  SocialError,
  type SocialPlatformAdapter,
} from "cordis-plugin-social";

async function setup() {
  const root = new Context();
  const service = await root.plugin(SocialService, { draftTtlMs: 60_000 });
  return { root, service };
}

function fakeAdapter(overrides: Partial<SocialPlatformAdapter> = {}): SocialPlatformAdapter {
  return {
    platform: "test",
    accountId: "default",
    capabilities: new Set(["auth.status", "post.create"]),
    authStatus: vi.fn(async () => ({ platform: "test", accountId: "default", state: "authenticated" })),
    preparePost: vi.fn(async (input) => ({
      preview: {
        platform: "test",
        accountId: "default",
        kind: input.kind ?? "post",
        text: input.text,
        media: input.media ?? [],
      },
      publish: vi.fn(async () => ({
        platform: "test",
        accountId: "default",
        url: "https://example.test/post/1",
        publishedAt: new Date().toISOString(),
      })),
      dispose: vi.fn(),
    })),
    ...overrides,
  };
}

describe("SocialService", () => {
  test("requires a two-phase prepare and confirmation token before publishing", async () => {
    const { root } = await setup();
    const adapter = fakeAdapter();
    const plugin = await root.inject(["social"], (ctx) => ctx.social.register(adapter));
    const draft = await root.social.preparePost({ platform: "test", text: "hello" });
    expect(draft.text).toBe("hello");
    await expect(root.social.publishPost(draft.id, "wrong-token"))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const result = await root.social.publishPost(draft.id, draft.confirmationToken);
    expect(result.url).toBe("https://example.test/post/1");
    expect(root.social.drafts()).toEqual([]);
    await plugin.dispose();
    await root.fiber.dispose();
  });

  test("adapter registration belongs to the consuming Cordis fiber", async () => {
    const { root } = await setup();
    const dispose = vi.fn();
    const adapter = fakeAdapter({
      preparePost: async (input) => ({
        preview: { platform: "test", accountId: "default", kind: "post", text: input.text, media: [] },
        publish: async () => ({ platform: "test", accountId: "default", publishedAt: new Date().toISOString() }),
        dispose,
      }),
    });
    const platformFiber = await root.inject(["social"], (ctx) => ctx.social.register(adapter));
    await root.social.preparePost({ platform: "test", text: "unpublished" });
    expect(root.social.platforms()).toHaveLength(1);
    await platformFiber.dispose();
    expect(root.social.platforms()).toEqual([]);
    expect(root.social.drafts()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(root.social.authStatus("test")).rejects.toBeInstanceOf(SocialError);
    await root.fiber.dispose();
  });

  test("validates reply and quote target URLs before opening a platform", async () => {
    const { root } = await setup();
    await root.inject(["social"], (ctx) => ctx.social.register(fakeAdapter({
      capabilities: new Set(["post.reply", "post.quote"]),
    })));
    await expect(root.social.preparePost({ platform: "test", kind: "reply", text: "reply" }))
      .rejects.toThrow("reply requires targetUrl");
    await expect(root.social.preparePost({
      platform: "test",
      kind: "quote",
      text: "quote",
      targetUrl: "ftp://example.com/not-web",
    })).rejects.toThrow("targetUrl must be an HTTP or HTTPS URL");
    await root.fiber.dispose();
  });
});
