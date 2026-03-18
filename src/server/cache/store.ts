export interface CacheStore {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  clear(): void;
  getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T>;
}

export class InvalidCacheTtlError extends Error {
  readonly key: string;
  readonly ttlMs: number;

  constructor(key: string, ttlMs: number) {
    super(`Cache TTL must be greater than 0 for key "${key}", got ${ttlMs}`);
    this.name = "InvalidCacheTtlError";
    this.key = key;
    this.ttlMs = ttlMs;
  }
}
