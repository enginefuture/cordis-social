# Cordis Social

Cordis Social is a lifecycle-safe plugin suite for everyday social-platform
operations. It currently supports X through a visible browser session and is
designed to be embedded into Codex, PingClaw Desk, CLIs, desktop apps, and other
Cordis hosts.

The project follows the current [`cordiverse/cordis`](https://github.com/cordiverse/cordis)
v4 plugin model: services are exposed on `Context`, dependencies use reactive
`inject`, configuration uses Standard Schema, and every registration, timer,
browser lease, and prepared post belongs to a reversible Cordis Fiber.

> Cordis v4 is currently an RC. This repository pins `cordis@4.0.0-rc.9` and
> tests lifecycle behavior against that exact release.

[中文说明](README.zh-CN.md)

## Packages

| Package | Cordis service / role |
| --- | --- |
| `cordis-plugin-social` | Provides `ctx.social`, platform registry, two-phase publishing, and lifecycle events |
| `cordis-plugin-social-browser` | Defines the provider-neutral `ctx.socialBrowser` contract |
| `cordis-plugin-social-browser-local` | Provides persistent local Chrome/Edge sessions without an API key |
| `cordis-plugin-social-profilefleet` | Provides clustered sessions through ProfileFleet |
| `cordis-plugin-social-x` | X login, text/image posts, replies, and quote posts |
| `cordis-plugin-social-tools` | Host-neutral JSON tools for Codex, PingClaw Desk, and agent runtimes |

## Design principles

- Platform plugins never own global process state.
- Browser providers can be replaced without changing the X plugin.
- Preparing a post never publishes it.
- Publishing requires the one-time confirmation token returned by prepare.
- Disposing a plugin reverses its registrations and releases open sessions.
- Credentials, cookies, browser profiles, and media are never stored by the
  social core.
- No CAPTCHA bypass, credential automation, bulk engagement, or hidden posting.

## Development quick start

The packages are npm-ready but are not published to npm yet:

```bash
git clone https://github.com/enginefuture/cordis-social.git
cd cordis-social
pnpm install
pnpm check
pnpm example
```

Run the interactive X login example:

```bash
pnpm example -- --login
```

The local provider creates an isolated persistent profile under
`~/.cordis-social/profiles/x-default`. It prefers Microsoft Edge, then Google
Chrome. The first login is manual; later sessions reuse the saved login state.

## Cordis usage

```ts
import { Context } from "cordis";
import SocialService from "cordis-plugin-social";
import LocalBrowserService from "cordis-plugin-social-browser-local";
import xPlugin from "cordis-plugin-social-x";
import SocialToolsService from "cordis-plugin-social-tools";

const ctx = new Context();

await Promise.all([
  ctx.plugin(xPlugin, { accountId: "default" }),
  ctx.plugin(SocialToolsService),
  ctx.plugin(SocialService),
  ctx.plugin(LocalBrowserService, {
    browser: "auto",
    profiles: { "x:default": "x-default" },
  }),
]);
```

Load order is intentionally arbitrary. The X and tools plugins declare their
required services and become active when those services appear.

## Safe publish flow

```ts
const draft = await ctx.social.preparePost({
  platform: "x",
  accountId: "default",
  text: "A prepared post",
  media: [{ path: "/absolute/path/chart.png" }],
});

console.log(draft.screenshotPath);
// Show the exact content and screenshot to the user, then ask for confirmation.

const published = await ctx.social.publishPost(
  draft.id,
  draft.confirmationToken,
);
```

If the user declines, or the host is shutting down:

```ts
await ctx.social.discardPost(draft.id);
```

Prepared posts expire after ten minutes by default. Tokens are random,
single-use, and compared in constant time.

## X capabilities

- Authentication status
- Interactive login with persistent sessions
- Text posts
- Up to four PNG/JPEG/GIF/WebP images
- Replies to an X URL
- Quote posts for an X URL
- Local preview and published-state screenshots

Media alt text is present in the core contract but the X browser plugin refuses
it until the X edit-media workflow is implemented. It never silently drops
accessibility text.

X changes its DOM without notice. Selector failures are surfaced as operation
errors; they never fall through to an unverified click.

## Browser providers

### Local Edge/Chrome

`cordis-plugin-social-browser-local` launches an ordinary system browser with
an isolated persistent profile and loopback-only CDP port. It requires no
CloakBrowser key. It is intended for local desktop use and owns one process at
a time per profile.

### ProfileFleet

```ts
import ProfileFleetBrowserService from "cordis-plugin-social-profilefleet";

await ctx.plugin(ProfileFleetBrowserService, {
  baseUrl: "http://127.0.0.1:47110",
  tokenEnv: "PROFILEFLEET_TOKEN",
  profiles: { "x:default": "x-publisher" },
});
```

The token is read from the named environment variable and is never included in
Cordis config, logs, or results. ProfileFleet remains responsible for profile
locks, capacity, leases, and orphan recovery.

Use a browser engine that the target platform accepts. During development, X
accepted a normal Edge profile but rejected CloakBrowser's login flow; the
provider boundary exists so platform support is not coupled to one fingerprint
engine.

## Host integration

`ctx.socialTools.list()` returns host-neutral tool descriptors with JSON Schema
and an async `execute` function. A Codex or PingClaw Desk bridge only needs to:

1. Register each descriptor in the host tool registry.
2. Forward the host `AbortSignal` to `execute`.
3. Display `social_prepare_post` output and screenshot to the user.
4. Call `social_publish_post` only after explicit user confirmation.
5. Dispose the Cordis root when the host session ends.

No OpenAI-, Codex-, or PingClaw-specific dependency is present in the platform
packages.

## Events

The core augments Cordis with:

- `social/platform-added`
- `social/platform-removed`
- `social/draft-prepared`
- `social/draft-discarded`
- `social/published`
- `social/error`

See [Architecture](docs/ARCHITECTURE.md), [Security](SECURITY.md), and
[Acceptable Use](ACCEPTABLE_USE.md).

MIT licensed.
