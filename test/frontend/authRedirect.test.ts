import { describe, expect, it } from "bun:test";
import {
  buildAuthPath,
  getSanitizedNextRedirect,
  sanitizeNextRedirect,
} from "../../src/frontend/lib/authRedirect";

describe("auth redirect helpers", () => {
  it("accepts safe internal redirects and preserves query and hash state", () => {
    expect(sanitizeNextRedirect("/threads?q=vacuum#latest")).toBe(
      "/threads?q=vacuum#latest"
    );
    expect(sanitizeNextRedirect("/threads/../people")).toBe("/people");
    expect(
      getSanitizedNextRedirect("?next=%2Fthreads%3Fq%3Dvacuum%23latest", "/fallback")
    ).toBe("/threads?q=vacuum#latest");
  });

  it("falls back for external, malformed, and control-character redirects", () => {
    for (const value of [
      null,
      undefined,
      "",
      "https://evil.example/phish",
      "//evil.example/phish",
      "/\\evil.example/phish",
      "javascript:alert(1)",
      "/threads\nSet-Cookie:bad=1",
    ]) {
      expect(sanitizeNextRedirect(value, "/fallback")).toBe("/fallback");
    }
  });

  it("only includes sanitized next targets when building auth links", () => {
    expect(buildAuthPath("/login", "/threads?q=vacuum#latest")).toBe(
      "/login?next=%2Fthreads%3Fq%3Dvacuum%23latest"
    );
    expect(buildAuthPath("/register", "https://evil.example/phish")).toBe("/register");
    expect(buildAuthPath("/forgot-password", null)).toBe("/forgot-password");
  });
});
