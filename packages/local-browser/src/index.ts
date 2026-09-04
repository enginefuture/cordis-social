import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Context } from "cordis";
import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import {
  SocialBrowserService,
  type AcquireSocialBrowserInput,
  type SocialBrowserLease,
} from "cordis-plugin-social-browser";

export type LocalBrowserName = "auto" | "chrome" | "edge";

const CANDIDATES: Record<NodeJS.Platform, Partial<Record<Exclude<LocalBrowserName, "auto">, string[]>>> = {
  darwin: {
    chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  },
  win32: {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    edge: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  linux: {
    chrome: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
  },
  aix: {}, android: {}, freebsd: {}, haiku: {}, openbsd: {}, sunos: {}, cygwin: {}, netbsd: {},
};

export function findLocalBrowser(
  browser: LocalBrowserName,
  executablePath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (executablePath) return existsSync(executablePath) ? executablePath : null;
  const candidates = CANDIDATES[platform] ?? {};
  const order: Array<"edge" | "chrome"> = browser === "auto"
    ? ["edge", "chrome"]
    : [browser];
  for (const name of order) {
    for (const path of candidates[name] ?? []) if (existsSync(path)) return path;
  }
  return null;
}

export namespace LocalBrowserService {
  export interface Config {
    browser?: LocalBrowserName;
    executablePath?: string;
    profilesDir?: string;
    defaultProfileId?: string;
    profiles?: Record<string, string>;
    portRange?: [number, number];
  }
}

export const Config = z.object({
  browser: z.enum(["auto", "chrome", "edge"]).default("auto"),
  executablePath: z.string().trim().min(1).optional(),
  profilesDir: z.string().trim().min(1).default(join(homedir(), ".cordis-social", "profiles")),
  defaultProfileId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  profiles: z.record(z.string(), z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/)).default({}),
  portRange: z.tuple([z.number().int().min(1).max(65_535), z.number().int().min(1).max(65_535)])
    .refine(([start, end]) => start <= end, "portRange start must be less than or equal to end")
    .default([9_400, 9_499]),
}).default({
  browser: "auto",
  profilesDir: join(homedir(), ".cordis-social", "profiles"),
  profiles: {},
  portRange: [9_400, 9_499],
});

interface ActiveBrowser {
  browser: Browser;
  child: ChildProcess;
  port: number;
  release(): Promise<void>;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

async function closePagesWithoutBeforeUnload(browser: Browser): Promise<void> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  await Promise.allSettled(pages.map(async (page) => {
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    await page.close({ runBeforeUnload: false });
  }));
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((result) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      result(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function discoverEndpoint(port: number): Promise<string> {
  let last = "not ready";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json() as { webSocketDebuggerUrl?: string };
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`Browser CDP endpoint on port ${port} ${last}`);
}

export class LocalBrowserService extends SocialBrowserService<LocalBrowserService.Config> {
  static readonly name = "social-browser-local";
  static readonly Config = Config;

  private readonly config: z.output<typeof Config>;
  private readonly executablePath: string;
  private readonly active = new Map<string, ActiveBrowser>();
  private readonly reservedPorts = new Set<number>();

  constructor(ctx: Context, config: LocalBrowserService.Config = {}) {
    super(ctx);
    this.config = Config.parse(config);
    const executablePath = findLocalBrowser(this.config.browser, this.config.executablePath);
    if (!executablePath) throw new Error(`No supported ${this.config.browser} browser executable was found`);
    this.executablePath = executablePath;
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.active.values()].map((entry) => entry.release()));
      this.active.clear();
      this.reservedPorts.clear();
    }, "social-browser-local.dispose");
  }

  async acquire(input: AcquireSocialBrowserInput): Promise<SocialBrowserLease> {
    input.signal?.throwIfAborted();
    const mappingKey = `${input.platform}:${input.accountId}`;
    const profileId = this.config.profiles[mappingKey]
      ?? this.config.profiles[`${input.platform}:default`]
      ?? this.config.defaultProfileId
      ?? mappingKey.replace(/[^A-Za-z0-9_-]/g, "-");
    if (this.active.has(profileId)) throw new Error(`Local browser profile "${profileId}" is already in use`);
    const profileDir = resolve(this.config.profilesDir, profileId);
    await mkdir(profileDir, { recursive: true });
    const port = await this.allocatePort();
    const child = spawn(this.executablePath, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-session-crashed-bubble",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { detached: false, stdio: "ignore" });
    try {
      const cdpEndpoint = await discoverEndpoint(port);
      const browser = await chromium.connectOverCDP(cdpEndpoint);
      const context = browser.contexts()[0];
      if (!context) throw new Error("System browser did not expose its persistent context");
      const page = context.pages()[0] ?? await context.newPage();
      if (input.initialUrl) await page.goto(input.initialUrl, { waitUntil: "domcontentloaded" });
      let released = false;
      let timer: NodeJS.Timeout | undefined;
      const release = async () => {
        if (released) return;
        released = true;
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        // X installs a beforeunload guard while a composer exists. Closing the
        // browser process first leaves a native "Leave site?" dialog and marks
        // the profile as crashed. Close tabs without unload handlers, request a
        // graceful browser shutdown, and wait for the owned process before the
        // profile or CDP port can be acquired again.
        await closePagesWithoutBeforeUnload(browser);
        await browser.close().catch(() => undefined);
        if (!await waitForChildExit(child, 2_000)) {
          try { child.kill("SIGTERM"); } catch { /* already stopped */ }
          await waitForChildExit(child, 2_000);
        }
        this.active.delete(profileId);
        this.reservedPorts.delete(port);
      };
      const abort = () => void release();
      input.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => void release(), (input.ttlSeconds ?? 600) * 1_000);
      timer.unref();
      this.active.set(profileId, { browser, child, port, release });
      const dispose = this.ctx.effect(() => release, `socialBrowser.acquire(${mappingKey})`);
      return {
        id: crypto.randomUUID(),
        profileId,
        context,
        page,
        release: async () => {
          await release();
          await dispose();
        },
      };
    } catch (error) {
      this.reservedPorts.delete(port);
      try { child.kill("SIGTERM"); } catch { /* already stopped */ }
      throw error;
    }
  }

  private async allocatePort(): Promise<number> {
    for (let port = this.config.portRange[0]; port <= this.config.portRange[1]; port += 1) {
      if (this.reservedPorts.has(port) || await portOpen(port)) continue;
      this.reservedPorts.add(port);
      return port;
    }
    throw new Error(`No local CDP port is available in ${this.config.portRange.join("-")}`);
  }
}

export default LocalBrowserService;
