import { MemoryCacheStore } from "./memory";

export const serverCache = new MemoryCacheStore();

export type { CacheStore } from "./store";
export { InvalidCacheTtlError } from "./store";
export { MemoryCacheStore } from "./memory";
