import { describe, expect, it } from "bun:test";
import { InvalidCacheTtlError, MemoryCacheStore } from "../../src/server/cache";

describe("MemoryCacheStore", () => {
  it("returns cached values until the TTL expires", async () => {
    let now = 1_000;
    const cache = new MemoryCacheStore(() => now);
    let loads = 0;

    const loader = async () => {
      loads += 1;
      return { value: loads };
    };

    const first = await cache.getOrLoad("analytics:test", 5_000, loader);
    const second = await cache.getOrLoad("analytics:test", 5_000, loader);

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(loads).toBe(1);

    now += 5_001;

    const third = await cache.getOrLoad("analytics:test", 5_000, loader);
    expect(third).toEqual({ value: 2 });
    expect(loads).toBe(2);
  });

  it("dedupes concurrent loads for the same key", async () => {
    const cache = new MemoryCacheStore();
    let resolves = 0;

    const loader = async () => {
      resolves += 1;
      await Promise.resolve();
      return { value: 42 };
    };

    const [first, second] = await Promise.all([
      cache.getOrLoad("analytics:test", 5_000, loader),
      cache.getOrLoad("analytics:test", 5_000, loader),
    ]);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(resolves).toBe(1);
  });

  it("throws for invalid TTL values", async () => {
    const cache = new MemoryCacheStore();

    expect(() => cache.set("analytics:test", { value: 1 }, 0)).toThrow(InvalidCacheTtlError);
    await expect(cache.getOrLoad("analytics:test", 0, async () => ({ value: 1 }))).rejects.toThrow(
      InvalidCacheTtlError,
    );
  });
});
