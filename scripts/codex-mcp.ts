import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import SocialService from "cordis-plugin-social";
import LocalBrowserService from "cordis-plugin-social-browser-local";
import SocialToolsService from "cordis-plugin-social-tools";
import xPlugin from "cordis-plugin-social-x";

const ctx = new Context();

await Promise.all([
  ctx.plugin(xPlugin, {
    accountId: "default",
    artifactsDir: join(homedir(), ".cordis-social", "artifacts", "x"),
  }),
  ctx.plugin(SocialToolsService),
  ctx.plugin(SocialService),
  ctx.plugin(LocalBrowserService, {
    browser: "auto",
    profiles: { "x:default": "x-default" },
  }),
]);

const server = new Server(
  { name: "cordis-social", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ctx.socialTools.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const result = await ctx.socialTools.execute(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: isRecord(result) ? result : { result },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  await ctx.fiber.dispose().catch(() => undefined);
}

server.onclose = () => void close();
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
