import { afterEach, describe, expect, it } from "bun:test";
import { createAuthStore } from "../../src/frontend/lib/state/auth";

const originalFetch = globalThis.fetch;

const activeUser = {
  createdAt: "2026-03-15T12:00:00.000Z",
  displayName: "Test User",
  email: "user@example.com",
  emailVerifiedAt: "2026-03-15T12:00:00.000Z",
  id: "42",
  status: "active" as const,
};

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Response | Promise<Response>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    status: init.status ?? 200,
  });
}

function installFetchStub(...handlers: FetchHandler[]) {
  const calls: Array<{
    init: RequestInit | undefined;
    url: string;
  }> = [];
  let handlerIndex = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      calls.push({ init, url });

      const handler = handlers[handlerIndex];
      handlerIndex += 1;

      if (!handler) {
        throw new Error(`Unexpected fetch call #${handlerIndex} for ${url}`);
      }

      return await handler(input, init);
    },
    writable: true,
  });

  return { calls };
}

function observeAuthState(store: ReturnType<typeof createAuthStore>) {
  let currentState = null as ReturnType<typeof createAuthStore> extends {
    subscribe: (run: (value: infer TValue) => void) => () => void;
  }
    ? TValue
    : never;

  const unsubscribe = store.subscribe((value) => {
    currentState = value;
  });

  return {
    get current() {
      return currentState;
    },
    unsubscribe,
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
    writable: true,
  });
});

describe("auth store", () => {
  it("deduplicates bootstrap requests and caches the ready auth state", async () => {
    const fetchStub = installFetchStub(async (_input, init) => {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.method).toBe("GET");
      return jsonResponse({ user: activeUser });
    });
    const store = createAuthStore();
    const observer = observeAuthState(store);

    const [firstBootstrap, secondBootstrap] = await Promise.all([
      store.bootstrap(),
      store.bootstrap(),
    ]);

    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.url).toBe("/api/auth/me");
    expect(firstBootstrap).toEqual({ user: activeUser });
    expect(secondBootstrap).toEqual({ user: activeUser });
    expect(observer.current).toMatchObject({
      bootstrapStatus: "ready",
      currentAction: null,
      error: null,
      isAuthenticated: true,
      isBootstrapped: true,
      isLoading: false,
      user: activeUser,
    });

    const cachedBootstrap = await store.bootstrap();

    expect(fetchStub.calls).toHaveLength(1);
    expect(cachedBootstrap).toEqual({ user: activeUser });

    observer.unsubscribe();
  });

  it("does not let an in-flight bootstrap overwrite newer session state", async () => {
    const deferred = createDeferred<Response>();
    installFetchStub(() => deferred.promise);
    const store = createAuthStore();
    const observer = observeAuthState(store);

    const bootstrapPromise = store.bootstrap();
    expect(observer.current).toMatchObject({
      bootstrapStatus: "loading",
      isBootstrapped: false,
      isLoading: true,
      user: null,
    });

    store.setUser(activeUser);
    expect(observer.current).toMatchObject({
      bootstrapStatus: "ready",
      isAuthenticated: true,
      isBootstrapped: true,
      user: activeUser,
    });

    deferred.resolve(jsonResponse({ user: null }));

    expect(await bootstrapPromise).toEqual({ user: null });
    expect(observer.current).toMatchObject({
      bootstrapStatus: "ready",
      isAuthenticated: true,
      user: activeUser,
    });

    observer.unsubscribe();
  });

  it("surfaces bootstrap failures without fabricating an authenticated user", async () => {
    installFetchStub(() => {
      throw new Error("network offline");
    });
    const store = createAuthStore();
    const observer = observeAuthState(store);

    await expect(store.bootstrap()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Network request failed",
      status: 0,
    });

    expect(observer.current).toMatchObject({
      bootstrapStatus: "error",
      currentAction: null,
      isAuthenticated: false,
      isBootstrapped: false,
      isLoading: false,
      user: null,
    });
    expect(observer.current.error).toMatchObject({
      code: "NETWORK_ERROR",
      message: "Network request failed",
      status: 0,
    });

    observer.unsubscribe();
  });

  it("transitions between logged-out and logged-in state through login and logout", async () => {
    const fetchStub = installFetchStub(
      async (_input, init) => {
        expect(init?.credentials).toBe("same-origin");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "user@example.com",
          password: "correct horse battery staple",
        });
        return jsonResponse({ user: activeUser });
      },
      async (_input, init) => {
        expect(init?.credentials).toBe("same-origin");
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
    );
    const store = createAuthStore();
    const observer = observeAuthState(store);

    const loginResponse = await store.login({
      email: "user@example.com",
      password: "correct horse battery staple",
    });

    expect(loginResponse).toEqual({ user: activeUser });
    expect(fetchStub.calls[0]?.url).toBe("/api/auth/login");
    expect(observer.current).toMatchObject({
      bootstrapStatus: "ready",
      currentAction: null,
      error: null,
      isAuthenticated: true,
      user: activeUser,
    });

    await store.logout();

    expect(fetchStub.calls[1]?.url).toBe("/api/auth/logout");
    expect(observer.current).toMatchObject({
      bootstrapStatus: "ready",
      currentAction: null,
      error: null,
      isAuthenticated: false,
      isBootstrapped: true,
      user: null,
    });

    observer.unsubscribe();
  });

  it("captures failed login attempts as store error state and lets callers clear them", async () => {
    installFetchStub(async () =>
      jsonResponse(
        {
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
        },
        {
          status: 401,
          statusText: "Unauthorized",
        }
      )
    );
    const store = createAuthStore();
    const observer = observeAuthState(store);

    await expect(
      store.login({
        email: "user@example.com",
        password: "wrong password value",
      })
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
      status: 401,
    });

    expect(observer.current).toMatchObject({
      currentAction: null,
      isAuthenticated: false,
      user: null,
    });
    expect(observer.current.error).toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
      status: 401,
    });

    store.clearError();
    expect(observer.current.error).toBeNull();

    observer.unsubscribe();
  });
});
