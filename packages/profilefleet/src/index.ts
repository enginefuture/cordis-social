import { Context } from "cordis";
import { z } from "zod";
import { ProfileFleetClient } from "profilefleet/client";
import { connectPlaywright } from "profilefleet/playwright";
import {
  SocialBrowserService,
  type AcquireSocialBrowserInput,
  type SocialBrowserLease,
} from "cordis-plugin-social-browser";

export namespace ProfileFleetBrowserService {
  export interface Config {
    baseUrl?: string;
    tokenEnv?: string;
    defaultProfileId?: string;
    profiles?: Record<string, string>;
    stopOnRelease?: boolean;
  }
}

const Config = z.object({
  baseUrl: z.url().default("http://127.0.0.1:47110"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("PROFILEFLEET_TOKEN"),
  defaultProfileId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  profiles: z.record(z.string(), z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/)).default({}),
  stopOnRelease: z.boolean().default(false),
}).default({
  baseUrl: "http://127.0.0.1:47110",
  tokenEnv: "PROFILEFLEET_TOKEN",
  profiles: {},
  stopOnRelease: false,
});

interface ActiveLease {
  release(stop?: boolean): Promise<void>;
}

export class ProfileFleetBrowserService extends SocialBrowserService<ProfileFleetBrowserService.Config> {
  static readonly name = "social-profilefleet";
  static readonly Config = Config;

  private readonly config: z.output<typeof Config>;
  private readonly client: ProfileFleetClient;
  private readonly active = new Map<string, ActiveLease>();

  constructor(ctx: Context, config: ProfileFleetBrowserService.Config = {}) {
    super(ctx);
    this.config = Config.parse(config);
    const token = process.env[this.config.tokenEnv];
    if (!token) throw new Error(`ProfileFleet token environment variable "${this.config.tokenEnv}" is not set`);
    this.client = new ProfileFleetClient({ baseUrl: this.config.baseUrl, token });
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.active.values()].map((lease) => lease.release(true)));
      this.active.clear();
    }, "social-profilefleet.dispose");
  }

  async acquire(input: AcquireSocialBrowserInput): Promise<SocialBrowserLease> {
    input.signal?.throwIfAborted();
    const mappingKey = `${input.platform}:${input.accountId}`;
    const profileId = this.config.profiles[mappingKey]
      ?? this.config.profiles[`${input.platform}:default`]
      ?? this.config.defaultProfileId;
    if (!profileId) {
      throw new Error(`No ProfileFleet profile configured for "${mappingKey}"`);
    }
    const managed = await this.client.acquireManaged({
      profileId,
      owner: `cordis-social:${mappingKey}:${input.purpose}`,
      ttlSeconds: input.ttlSeconds ?? 600,
      requestId: `cordis-social-${crypto.randomUUID()}`,
      ...(input.initialUrl ? { initialUrl: input.initialUrl } : {}),
    });
    const browser = await connectPlaywright(managed.lease);
    const context = browser.contexts()[0];
    if (!context) {
      await managed.stop();
      throw new Error("ProfileFleet CDP connection did not expose a browser context");
    }
    const page = context.pages()[0] ?? await context.newPage();
    let released = false;
    const release = async (stop = this.config.stopOnRelease) => {
      if (released) return;
      released = true;
      input.signal?.removeEventListener("abort", abort);
      this.active.delete(managed.lease.id);
      await managed.release({ stop });
    };
    const abort = () => void release(true);
    input.signal?.addEventListener("abort", abort, { once: true });
    this.active.set(managed.lease.id, { release });

    // Bind the browser lease to the consuming plugin's Cordis fiber. The
    // service proxy rewrites this.ctx to the call site.
    const dispose = this.ctx.effect(() => () => release(true), `socialBrowser.acquire(${mappingKey})`);
    return {
      id: managed.lease.id,
      profileId,
      context,
      page,
      release: async (options) => {
        await release(options?.stop);
        await dispose();
      },
    };
  }
}

export default ProfileFleetBrowserService;
