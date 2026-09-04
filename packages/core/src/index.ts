import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";

export type SocialPlatformId = string;
export type SocialAccountId = string;

export type SocialCapability =
  | "auth.status"
  | "auth.login"
  | "post.create"
  | "post.reply"
  | "post.quote";

export type SocialAuthState = "authenticated" | "required" | "challenge" | "unknown";

export interface SocialAuthResult {
  platform: SocialPlatformId;
  accountId: SocialAccountId;
  state: SocialAuthState;
  message?: string;
}

export interface SocialMediaInput {
  path: string;
  alt?: string;
}

export interface PreparePostInput {
  platform: SocialPlatformId;
  accountId?: SocialAccountId;
  kind?: "post" | "reply" | "quote";
  text: string;
  media?: SocialMediaInput[];
  targetUrl?: string;
}

export interface PostPreview {
  platform: SocialPlatformId;
  accountId: SocialAccountId;
  kind: "post" | "reply" | "quote";
  text: string;
  media: SocialMediaInput[];
  targetUrl?: string;
  screenshotPath?: string;
}

export interface PreparedPost extends PostPreview {
  id: string;
  confirmationToken: string;
  expiresAt: string;
}

export interface PublishedPost {
  platform: SocialPlatformId;
  accountId: SocialAccountId;
  postId?: string;
  url?: string;
  screenshotPath?: string;
  publishedAt: string;
}

export interface AdapterPreparedPost {
  preview: PostPreview;
  publish(signal?: AbortSignal): Promise<PublishedPost>;
  dispose(): void | Promise<void>;
}

export interface SocialPlatformAdapter {
  readonly platform: SocialPlatformId;
  readonly accountId: SocialAccountId;
  readonly capabilities: ReadonlySet<SocialCapability>;
  authStatus(signal?: AbortSignal): Promise<SocialAuthResult>;
  login?(signal?: AbortSignal): Promise<SocialAuthResult>;
  preparePost(input: PreparePostInput, signal?: AbortSignal): Promise<AdapterPreparedPost>;
}

interface ManagedPreparedPost {
  public: PreparedPost;
  handle: AdapterPreparedPost;
  timer: NodeJS.Timeout;
  ownerKey: string;
}

export namespace SocialService {
  export interface Config {
    defaultAccountId?: string;
    draftTtlMs?: number;
    maxPrepared?: number;
  }
}

const configSchema = z.object({
  defaultAccountId: z.string().trim().min(1).max(120).default("default"),
  draftTtlMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  maxPrepared: z.number().int().min(1).max(1_000).default(32),
}).default({ defaultAccountId: "default", draftTtlMs: 600_000, maxPrepared: 32 });

const prepareSchema = z.object({
  platform: z.string().trim().min(1).max(64),
  accountId: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["post", "reply", "quote"]).default("post"),
  text: z.string().trim().min(1).max(10_000),
  media: z.array(z.object({
    path: z.string().trim().min(1),
    alt: z.string().trim().max(1_000).optional(),
  })).max(16).default([]),
  targetUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "targetUrl must be an HTTP or HTTPS URL").optional(),
}).superRefine((value, context) => {
  if (value.kind !== "post" && !value.targetUrl) {
    context.addIssue({ code: "custom", message: `${value.kind} requires targetUrl`, path: ["targetUrl"] });
  }
});

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adapterKey(platform: string, accountId: string): string {
  return `${platform}:${accountId}`;
}

export class SocialError extends Error {
  constructor(
    readonly code: "ADAPTER_NOT_FOUND" | "CAPABILITY_UNAVAILABLE" | "DRAFT_NOT_FOUND" | "CONFIRMATION_REQUIRED" | "DRAFT_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "SocialError";
  }
}

declare module "cordis" {
  interface Context {
    social: SocialService;
  }

  interface Events {
    "social/platform-added"(adapter: SocialPlatformAdapter): void;
    "social/platform-removed"(adapter: SocialPlatformAdapter): void;
    "social/draft-prepared"(draft: PreparedPost): void;
    "social/draft-discarded"(draft: PreparedPost, reason: string): void;
    "social/published"(draft: PreparedPost, result: PublishedPost): void;
    "social/error"(operation: string, error: unknown): void;
  }
}

export class SocialService extends Service<SocialService.Config> {
  static readonly name = "social";
  static readonly Config = configSchema;

  private readonly adapters = new Map<string, SocialPlatformAdapter>();
  private readonly prepared = new Map<string, ManagedPreparedPost>();
  private readonly config: z.output<typeof configSchema>;

  constructor(ctx: Context, config: SocialService.Config = {}) {
    super(ctx, "social");
    this.config = configSchema.parse(config);
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.prepared.values()].map((draft) => this.disposeDraft(draft, "service-disposed")));
      this.prepared.clear();
      this.adapters.clear();
    }, "social.dispose");
  }

  register(adapter: SocialPlatformAdapter): () => void {
    const key = adapterKey(adapter.platform, adapter.accountId);
    if (this.adapters.has(key)) throw new Error(`Social adapter "${key}" is already registered`);
    return this.ctx.effect(() => {
      this.adapters.set(key, adapter);
      this.ctx.emit("social/platform-added", adapter);
      return async () => {
        this.adapters.delete(key);
        const drafts = [...this.prepared.values()].filter((draft) => draft.ownerKey === key);
        await Promise.allSettled(drafts.map((draft) => this.disposeDraft(draft, "adapter-disposed")));
        this.ctx.emit("social/platform-removed", adapter);
      };
    }, `social.register(${JSON.stringify(key)})`);
  }

  platforms(): Array<{ platform: string; accountId: string; capabilities: SocialCapability[] }> {
    return [...this.adapters.values()].map((adapter) => ({
      platform: adapter.platform,
      accountId: adapter.accountId,
      capabilities: [...adapter.capabilities].sort(),
    }));
  }

  drafts(): PreparedPost[] {
    return [...this.prepared.values()].map((draft) => ({ ...draft.public }));
  }

  async authStatus(platform: string, accountId = this.config.defaultAccountId, signal?: AbortSignal) {
    return this.adapter(platform, accountId, "auth.status").authStatus(signal);
  }

  async login(platform: string, accountId = this.config.defaultAccountId, signal?: AbortSignal) {
    const adapter = this.adapter(platform, accountId, "auth.login");
    if (!adapter.login) throw new SocialError("CAPABILITY_UNAVAILABLE", `${platform} does not support interactive login`);
    return adapter.login(signal);
  }

  async preparePost(input: PreparePostInput, signal?: AbortSignal): Promise<PreparedPost> {
    if (this.prepared.size >= this.config.maxPrepared) {
      throw new SocialError("DRAFT_LIMIT", `Prepared draft limit reached (${this.config.maxPrepared})`);
    }
    const parsed = prepareSchema.parse(input);
    const accountId = parsed.accountId ?? this.config.defaultAccountId;
    const capability = `post.${parsed.kind === "post" ? "create" : parsed.kind}` as SocialCapability;
    const adapter = this.adapter(parsed.platform, accountId, capability);
    const normalized: PreparePostInput = {
      platform: parsed.platform,
      accountId,
      kind: parsed.kind,
      text: parsed.text,
      media: parsed.media.map((item) => ({
        path: item.path,
        ...(item.alt ? { alt: item.alt } : {}),
      })),
      ...(parsed.targetUrl ? { targetUrl: parsed.targetUrl } : {}),
    };
    let handle: AdapterPreparedPost;
    try {
      handle = await adapter.preparePost(normalized, signal);
    } catch (error) {
      this.ctx.emit("social/error", "preparePost", error);
      throw error;
    }
    const id = randomUUID();
    const confirmationToken = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.draftTtlMs).toISOString();
    const publicDraft: PreparedPost = { id, confirmationToken, expiresAt, ...handle.preview };
    const managed = {
      public: publicDraft,
      handle,
      ownerKey: adapterKey(adapter.platform, adapter.accountId),
      timer: setTimeout(() => void this.discardPost(id, "expired"), this.config.draftTtlMs),
    };
    managed.timer.unref();
    this.prepared.set(id, managed);
    this.ctx.emit("social/draft-prepared", publicDraft);
    return { ...publicDraft };
  }

  async publishPost(id: string, confirmationToken: string, signal?: AbortSignal): Promise<PublishedPost> {
    const managed = this.prepared.get(id);
    if (!managed) throw new SocialError("DRAFT_NOT_FOUND", `Prepared draft "${id}" was not found`);
    if (!secureEqual(managed.public.confirmationToken, confirmationToken)) {
      throw new SocialError("CONFIRMATION_REQUIRED", "The exact confirmation token from preparePost is required");
    }
    clearTimeout(managed.timer);
    this.prepared.delete(id);
    try {
      const result = await managed.handle.publish(signal);
      this.ctx.emit("social/published", managed.public, result);
      return result;
    } catch (error) {
      this.ctx.emit("social/error", "publishPost", error);
      throw error;
    } finally {
      await managed.handle.dispose();
    }
  }

  async discardPost(id: string, reason = "discarded"): Promise<void> {
    const managed = this.prepared.get(id);
    if (!managed) return;
    this.prepared.delete(id);
    await this.disposeDraft(managed, reason);
  }

  private adapter(platform: string, accountId: string, capability: SocialCapability): SocialPlatformAdapter {
    const adapter = this.adapters.get(adapterKey(platform, accountId));
    if (!adapter) throw new SocialError("ADAPTER_NOT_FOUND", `No adapter for ${platform}:${accountId}`);
    if (!adapter.capabilities.has(capability)) {
      throw new SocialError("CAPABILITY_UNAVAILABLE", `${platform}:${accountId} does not support ${capability}`);
    }
    return adapter;
  }

  private async disposeDraft(managed: ManagedPreparedPost, reason: string): Promise<void> {
    clearTimeout(managed.timer);
    this.prepared.delete(managed.public.id);
    await managed.handle.dispose();
    this.ctx.emit("social/draft-discarded", managed.public, reason);
  }
}

export default SocialService;
