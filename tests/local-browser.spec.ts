import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { Config, findLocalBrowser } from "cordis-plugin-social-browser-local";

describe("LocalBrowserService configuration", () => {
  test("resolves an explicit executable and rejects missing files", () => {
    const existing = resolve("package.json");
    expect(findLocalBrowser("auto", existing)).toBe(existing);
    expect(findLocalBrowser("auto", resolve("does-not-exist"))).toBeNull();
  });

  test("rejects profile path traversal and inverted port ranges", () => {
    expect(Config.safeParse({ profiles: { "x:default": "../escape" } }).success).toBe(false);
    expect(Config.safeParse({ portRange: [9_500, 9_400] }).success).toBe(false);
  });
});
