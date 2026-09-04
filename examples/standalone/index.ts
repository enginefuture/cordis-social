import { Context } from "cordis";
import SocialService from "cordis-plugin-social";
import LocalBrowserService from "cordis-plugin-social-browser-local";
import xPlugin from "cordis-plugin-social-x";
import SocialToolsService from "cordis-plugin-social-tools";

const ctx = new Context();

// Cordis injection makes load order irrelevant; providers and consumers become
// active when their declared services are available.
await Promise.all([
  ctx.plugin(xPlugin, { accountId: "default" }),
  ctx.plugin(SocialToolsService),
  ctx.plugin(SocialService),
  ctx.plugin(LocalBrowserService, {
    browser: "auto",
    profiles: { "x:default": "x-default" },
  }),
]);

console.table(ctx.social.platforms());
console.log("Host-neutral tools:", ctx.socialTools.list().map((tool) => tool.name).join(", "));

if (process.argv.includes("--login")) {
  console.log(await ctx.social.login("x"));
}

await ctx.fiber.dispose();
