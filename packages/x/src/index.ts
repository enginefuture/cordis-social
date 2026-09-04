import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Context } from "cordis";
import type { Locator, Page } from "playwright-core";
import { z } from "zod";
import type { SocialBrowserLease } from "cordis-plugin-social-browser";
import type {
  AdapterPreparedPost,
  PreparePostInput,
  PublishedPost,
  SocialAuthResult,
  SocialAuthState,
  SocialCapability,
  SocialPlatformAdapter,
} from "cordis-plugin-social";
import type {} from "cordis-plugin-social-browser";

export namespace XPlugin {
  export interface Config {
    accountId?: string;
    artifactsDir?: string;
    loginTimeoutMs?: number;
    statusTimeoutMs?: number;
  }
}

export const Config = z.object({
  accountId: z.string().trim().min(1).max(120).default("default"),
  artifactsDir: z.string().trim().min(1).default("social-artifacts/x"),
  loginTimeoutMs: z.number().int().min(30_000).max(900_000).default(300_000),
  statusTimeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
}).default({
  accountId: "default",
  artifactsDir: "social-artifacts/x",
  loginTimeoutMs: 300_000,
  statusTimeoutMs: 10_000,
});

export const name = "social-x";
export const inject = ["social", "socialBrowser"];

const X_HOME = "https://x.com/home";

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(resolveSleep, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function pageAuthState(page: Page): Promise<SocialAuthState> {
  if (page.isClosed()) return "unknown";
  const url = page.url().toLowerCase();
  if (/\/(i\/flow\/login|login)(?:[/?#]|$)/.test(url)) return "required";
  if (/\/(account\/access|i\/flow\/consent_flow|challenge)(?:[/?#]|$)/.test(url)) return "challenge";
  const authenticated = page.locator([
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    'a[data-testid="AppTabBar_Home_Link"]',
    'a[href="/compose/post"]',
    '[data-testid="primaryColumn"] [data-testid="tweet"]',
  ].join(", ")).first();
  if (await authenticated.count() && await authenticated.isVisible().catch(() => false)) {
    return "authenticated";
  }
  return "unknown";
}

async function contextAuthState(lease: SocialBrowserLease): Promise<{ state: SocialAuthState; page: Page }> {
  let pages = lease.context.pages().filter((page) => !page.isClosed());
  if (!pages.length) {
    const replacement = await lease.context.newPage();
    await replacement.goto(X_HOME, { waitUntil: "domcontentloaded" });
    pages = [replacement];
  }
  let result: { state: SocialAuthState; page: Page } = { state: "unknown", page: pages[0]! };
  for (const page of pages) {
    const state = await pageAuthState(page).catch(() => "unknown" as const);
    if (state === "authenticated") return { state, page };
    if (state === "challenge") result = { state, page };
    else if (state === "required" && result.state === "unknown") result = { state, page };
  }
  return result;
}

async function waitForLogin(lease: SocialBrowserLease, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await contextAuthState(lease);
    if (current.state === "authenticated") return current;
    await sleep(1_000, signal);
  }
  return contextAuthState(lease);
}

async function waitForAuthState(lease: SocialBrowserLease, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  let current = await contextAuthState(lease);
  while (current.state === "unknown" && Date.now() < deadline) {
    await sleep(500, signal);
    current = await contextAuthState(lease);
  }
  return current;
}

function requireXTarget(value: string | undefined): string {
  if (!value) throw new Error("This operation requires an X target URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) {
    throw new Error("Target must be an HTTPS x.com or twitter.com URL");
  }
  return url.toString();
}

async function visibleComposer(page: Page): Promise<Locator> {
  const composer = page.locator([
    '[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][contenteditable="true"][data-testid^="tweetTextarea"]',
  ].join(", ")).filter({ visible: true }).first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  return composer;
}

async function visiblePostButton(page: Page): Promise<Locator> {
  const button = page.locator([
    'button[data-testid="tweetButton"]',
    'button[data-testid="tweetButtonInline"]',
  ].join(", ")).filter({ visible: true }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const candidates = [...document.querySelectorAll<HTMLButtonElement>(
      'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]',
    )];
    return candidates.some((candidate) => candidate.offsetParent !== null
      && !candidate.disabled
      && candidate.getAttribute("aria-disabled") !== "true");
  }, undefined, { timeout: 60_000 });
  return button;
}

async function openComposer(page: Page, input: PreparePostInput): Promise<void> {
  const kind = input.kind ?? "post";
  if (kind === "post") {
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
    return;
  }
  await page.goto(requireXTarget(input.targetUrl), { waitUntil: "domcontentloaded" });
  if (kind === "reply") {
    const reply = page.locator('[data-testid="reply"]').first();
    await reply.waitFor({ state: "visible", timeout: 30_000 });
    await reply.click();
    return;
  }
  const repost = page.locator('[data-testid="retweet"], [data-testid="unretweet"]').first();
  await repost.waitFor({ state: "visible", timeout: 30_000 });
  await repost.click();
  const quote = page.getByRole("menuitem").filter({ hasText: /quote|引用/i }).first();
  await quote.waitFor({ state: "visible", timeout: 15_000 });
  await quote.click();
}

async function fillPost(page: Page, input: PreparePostInput): Promise<Locator> {
  await openComposer(page, input);
  const composer = await visibleComposer(page);
  await composer.click();
  await page.keyboard.insertText(input.text);
  const actual = (await composer.innerText()).trim();
  if (!actual || (!input.text.includes(actual) && !actual.includes(input.text))) {
    throw new Error("X composer text verification failed");
  }
  const media = input.media ?? [];
  if (media.length > 4) throw new Error("X supports at most four images per regular post");
  if (media.some((item) => item.alt)) {
    throw new Error("X media alt text is not implemented yet; refusing to silently drop accessibility text");
  }
  const paths = media.map((item) => resolve(item.path));
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`Media file does not exist: ${path}`);
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) throw new Error(`Unsupported X image type: ${path}`);
  }
  if (paths.length) {
    await page.locator('input[data-testid="fileInput"][type="file"]').first().setInputFiles(paths);
    await page.locator('[data-testid="attachments"]').waitFor({ state: "visible", timeout: 60_000 });
  }
  return visiblePostButton(page);
}

function artifactPath(directory: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(directory, `${stamp}-${label}.png`);
}

class XAdapter implements SocialPlatformAdapter {
  readonly platform = "x";
  readonly capabilities = new Set<SocialCapability>([
    "auth.status",
    "auth.login",
    "post.create",
    "post.reply",
    "post.quote",
  ]);

  constructor(
    private readonly ctx: Context,
    readonly accountId: string,
    private readonly config: z.output<typeof Config>,
  ) {}

  async authStatus(signal?: AbortSignal): Promise<SocialAuthResult> {
    const lease = await this.ctx.socialBrowser.acquire({
      platform: this.platform,
      accountId: this.accountId,
      purpose: "auth",
      initialUrl: X_HOME,
      ttlSeconds: 120,
      ...(signal ? { signal } : {}),
    });
    try {
      const { state } = await waitForAuthState(lease, this.config.statusTimeoutMs, signal);
      return { platform: this.platform, accountId: this.accountId, state };
    } finally {
      await lease.release();
    }
  }

  async login(signal?: AbortSignal): Promise<SocialAuthResult> {
    const lease = await this.ctx.socialBrowser.acquire({
      platform: this.platform,
      accountId: this.accountId,
      purpose: "auth",
      initialUrl: X_HOME,
      ttlSeconds: Math.ceil(this.config.loginTimeoutMs / 1_000) + 60,
      ...(signal ? { signal } : {}),
    });
    try {
      const { state } = await waitForLogin(lease, this.config.loginTimeoutMs, signal);
      return {
        platform: this.platform,
        accountId: this.accountId,
        state,
        ...(state === "authenticated"
          ? { message: "Persistent X login is ready" }
          : { message: "Complete the visible X login or account challenge manually" }),
      };
    } finally {
      await lease.release();
    }
  }

  async preparePost(input: PreparePostInput, signal?: AbortSignal): Promise<AdapterPreparedPost> {
    const lease = await this.ctx.socialBrowser.acquire({
      platform: this.platform,
      accountId: this.accountId,
      purpose: "compose",
      initialUrl: X_HOME,
      ttlSeconds: 900,
      ...(signal ? { signal } : {}),
    });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await lease.release();
    };
    try {
      const auth = await contextAuthState(lease);
      if (auth.state !== "authenticated") {
        throw new Error(`X account ${this.accountId} is not authenticated (${auth.state})`);
      }
      const button = await fillPost(auth.page, input);
      await mkdir(this.config.artifactsDir, { recursive: true });
      const previewPath = artifactPath(this.config.artifactsDir, "preview");
      await auth.page.screenshot({ path: previewPath });
      const preview = {
        platform: this.platform,
        accountId: this.accountId,
        kind: input.kind ?? "post",
        text: input.text,
        media: input.media ?? [],
        ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
        screenshotPath: previewPath,
      } as const;
      return {
        preview,
        publish: async (publishSignal): Promise<PublishedPost> => {
          publishSignal?.throwIfAborted();
          await button.click();
          await Promise.race([
            auth.page.locator('[data-testid="toast"]').waitFor({ state: "visible", timeout: 30_000 }),
            auth.page.waitForURL((url) => !url.pathname.includes("/compose/post"), { timeout: 30_000 }),
          ]);
          const toastLink = auth.page.locator('[data-testid="toast"] a').first();
          const href = await toastLink.getAttribute("href").catch(() => null);
          const screenshotPath = artifactPath(this.config.artifactsDir, "published");
          await auth.page.screenshot({ path: screenshotPath });
          return {
            platform: this.platform,
            accountId: this.accountId,
            ...(href ? { url: new URL(href, "https://x.com").toString() } : {}),
            screenshotPath,
            publishedAt: new Date().toISOString(),
          };
        },
        dispose: release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
}

export function apply(ctx: Context, input: XPlugin.Config = {}) {
  const config = Config.parse(input);
  return ctx.social.register(new XAdapter(ctx, config.accountId, config));
}

const plugin = { name, inject, Config, apply };
export default plugin;
