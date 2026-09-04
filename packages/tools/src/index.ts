import { Context, Service } from "cordis";
import { z } from "zod";
import type { PreparePostInput } from "cordis-plugin-social";
import type {} from "cordis-plugin-social";

export interface SocialHostTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

const accountInput = z.object({
  platform: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

const prepareInput = z.object({
  platform: z.string().min(1),
  accountId: z.string().min(1).optional(),
  kind: z.enum(["post", "reply", "quote"]).default("post"),
  text: z.string().min(1).max(10_000),
  media: z.array(z.object({ path: z.string().min(1), alt: z.string().optional() })).max(16).optional(),
  targetUrl: z.url().optional(),
});

const publishInput = z.object({
  id: z.string().uuid(),
  confirmationToken: z.string().min(1),
});

const discardInput = z.object({
  id: z.string().uuid(),
});

declare module "cordis" {
  interface Context {
    socialTools: SocialToolsService;
  }
}

export class SocialToolsService extends Service {
  static readonly name = "social-tools";
  static readonly inject = ["social"];

  private readonly tools: SocialHostTool[];

  constructor(ctx: Context) {
    super(ctx, "socialTools");
    this.tools = [
      {
        name: "social_platforms",
        description: "List configured social platforms, accounts, and capabilities.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ctx.social.platforms(),
      },
      {
        name: "social_auth_status",
        description: "Check whether a configured social account is authenticated.",
        inputSchema: {
          type: "object",
          required: ["platform"],
          properties: { platform: { type: "string" }, accountId: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input, signal) => {
          const value = accountInput.parse(input);
          return ctx.social.authStatus(value.platform, value.accountId, signal);
        },
      },
      {
        name: "social_login",
        description: "Open an interactive login session. Credentials and challenges must be completed by the user.",
        inputSchema: {
          type: "object",
          required: ["platform"],
          properties: { platform: { type: "string" }, accountId: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input, signal) => {
          const value = accountInput.parse(input);
          return ctx.social.login(value.platform, value.accountId, signal);
        },
      },
      {
        name: "social_prepare_post",
        description: "Prepare and preview a social post. This never publishes and returns a one-time confirmation token.",
        inputSchema: {
          type: "object",
          required: ["platform", "text"],
          properties: {
            platform: { type: "string" },
            accountId: { type: "string" },
            kind: { enum: ["post", "reply", "quote"] },
            text: { type: "string", minLength: 1, maxLength: 10_000 },
            media: { type: "array", maxItems: 16, items: { type: "object", required: ["path"], properties: { path: { type: "string" }, alt: { type: "string" } } } },
            targetUrl: { type: "string", format: "uri" },
          },
          additionalProperties: false,
        },
        execute: async (input, signal) => {
          const value = prepareInput.parse(input);
          const request: PreparePostInput = {
            platform: value.platform,
            kind: value.kind,
            text: value.text,
            ...(value.accountId ? { accountId: value.accountId } : {}),
            ...(value.media ? {
              media: value.media.map((item) => ({
                path: item.path,
                ...(item.alt ? { alt: item.alt } : {}),
              })),
            } : {}),
            ...(value.targetUrl ? { targetUrl: value.targetUrl } : {}),
          };
          return ctx.social.preparePost(request, signal);
        },
      },
      {
        name: "social_publish_post",
        description: "Publish a previously prepared post after explicit user confirmation using its one-time token.",
        inputSchema: {
          type: "object",
          required: ["id", "confirmationToken"],
          properties: { id: { type: "string", format: "uuid" }, confirmationToken: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input, signal) => {
          const value = publishInput.parse(input);
          return ctx.social.publishPost(value.id, value.confirmationToken, signal);
        },
      },
      {
        name: "social_discard_post",
        description: "Discard a prepared post and release its browser session without publishing.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
          additionalProperties: false,
        },
        execute: async (input) => {
          const value = discardInput.parse(input);
          await ctx.social.discardPost(value.id, "tool-discarded");
          return { discarded: true, id: value.id };
        },
      },
    ];
  }

  list(): SocialHostTool[] {
    return [...this.tools];
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown social tool "${name}"`);
    return tool.execute(input, signal);
  }
}

export default SocialToolsService;
