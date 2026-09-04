import { Context, Service } from "cordis";
import type { BrowserContext, Page } from "playwright-core";

export interface AcquireSocialBrowserInput {
  platform: string;
  accountId: string;
  purpose: "auth" | "compose" | "read";
  initialUrl?: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
}

export interface SocialBrowserLease {
  id: string;
  profileId: string;
  context: BrowserContext;
  page: Page;
  release(options?: { stop?: boolean }): Promise<void>;
}

declare module "cordis" {
  interface Context {
    socialBrowser: SocialBrowserService;
  }
}

export abstract class SocialBrowserService<Config = never> extends Service<Config> {
  constructor(ctx: Context) {
    super(ctx, "socialBrowser");
  }

  abstract acquire(input: AcquireSocialBrowserInput): Promise<SocialBrowserLease>;
}

export default SocialBrowserService;
