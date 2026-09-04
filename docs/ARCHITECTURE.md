# Architecture

## Plugin graph

```text
Cordis Context
├── social                     cordis-plugin-social
│   ├── adapter x:default      cordis-plugin-social-x
│   └── prepared-post store    in-memory, TTL bounded
├── socialBrowser              exactly one provider
│   ├── local Edge/Chrome      cordis-plugin-social-browser-local
│   └── ProfileFleet client    cordis-plugin-social-profilefleet
└── socialTools                cordis-plugin-social-tools
    └── Codex / PingClaw / CLI host bridge
```

The X plugin injects `social` and `socialBrowser`. The tools plugin injects
`social`. Cordis keeps consumers pending until providers exist and automatically
reverses their effects when a dependency disappears.

## Lifecycle ownership

- `SocialService` owns adapter and prepared-post registries.
- `social.register()` is invoked through Cordis's traceable service proxy, so
  its `ctx.effect()` belongs to the adapter plugin's calling Fiber.
- Browser provider `acquire()` follows the same rule: its cleanup belongs to the
  X plugin operation's Fiber, not to global process state.
- A prepared post owns its browser lease until publish, discard, expiry, adapter
  disposal, or root disposal.
- Publication removes a prepared post before clicking, preventing duplicate
  commit calls with the same token.

## Publish state machine

```text
input → validate → acquire browser → verify login → compose → screenshot
                                                            │
                                                      PREPARED + token
                                                      /              \
                                         confirm + token              decline / TTL
                                                │                         │
                                             publish                   discard
                                                │                         │
                                         result + screenshot       release browser
                                                │
                                         release browser
```

Confirmation tokens are 144-bit random values, single-use, memory-only, and
compared in constant time. They coordinate an agent/user approval boundary;
they are not a substitute for process or operating-system security.

## Browser boundary

`SocialBrowserService` exposes a Playwright `BrowserContext` and `Page` inside a
lifecycle-managed lease. The X adapter does not know whether that page comes
from a local system browser, ProfileFleet, or a future remote provider.

The local provider is intentionally small and single-process. Use ProfileFleet
when multiple applications share profiles or when locks, capacity, renewal,
and orphan recovery matter.

## Host boundary

`SocialToolsService` exposes JSON-Schema tool descriptors without importing an
agent SDK. Host packages should translate those descriptors into their native
registration format and forward cancellation. This keeps platform code stable
when Codex, PingClaw Desk, or another host changes its tool API.

## Adding a platform

1. Implement `SocialPlatformAdapter`.
2. Declare capabilities truthfully.
3. Acquire sessions only through `ctx.socialBrowser`.
4. Return an `AdapterPreparedPost` whose `publish` performs the externally
   visible action and whose `dispose` is idempotent.
5. Register through `ctx.social.register()` inside a plugin with
   `static inject = ['social', 'socialBrowser']` or equivalent object metadata.
6. Add selector/transport tests, lifecycle disposal tests, package metadata,
   and bilingual documentation.
