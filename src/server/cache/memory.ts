import { InvalidCacheTtlError, type CacheStore } from "./store";

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private assertValidTtl(key: string, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new InvalidCacheTtlError(key, ttlMs);
    }
  }

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.assertValidTtl(key, ttlMs);

    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.inFlight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    this.assertValidTtl(key, ttlMs);

    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const loadPromise = (async () => {
      const value = await loader();
      this.set(key, value, ttlMs);
      return value;
    })().finally(() => {
      if (this.inFlight.get(key) === loadPromise) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, loadPromise);
    return loadPromise;
  }
}
