import { afterEach, describe, expect, it } from "bun:test";
import { fetchAnalyticsPayload, createAnalyticsStore } from "../../src/frontend/lib/analytics";
import { getAnalyticsSummary } from "../../src/frontend/lib/api";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const emptySummary = { totalMessages: 0, totalThreads: 0, uniqueSenders: 0, monthsIngested: 0 };
const emptyAll = { summary: emptySummary, byMonth: [], byHour: [], byDow: [], topSenders: [] };

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return handler(url);
    },
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
    writable: true,
  });
});

describe("getAnalyticsSummary", () => {
  it("includes list params when listIds are provided", async () => {
    let capturedUrl = "";
    stubFetch((url) => {
      capturedUrl = url;
      return jsonResponse(emptySummary);
    });

    await getAnalyticsSummary({ listIds: [3, 7] });

    expect(capturedUrl).toContain("list=3");
    expect(capturedUrl).toContain("list=7");
  });

  it("omits list params when listIds is empty", async () => {
    let capturedUrl = "";
    stubFetch((url) => {
      capturedUrl = url;
      return jsonResponse(emptySummary);
    });

    await getAnalyticsSummary({ listIds: [] });

    expect(capturedUrl).not.toContain("list=");
  });

  it("omits list params when no params are passed", async () => {
    let capturedUrl = "";
    stubFetch((url) => {
      capturedUrl = url;
      return jsonResponse(emptySummary);
    });

    await getAnalyticsSummary();

    expect(capturedUrl).not.toContain("list=");
  });
});

describe("fetchAnalyticsPayload", () => {
  it("makes a single request to /analytics/all with list IDs", async () => {
    const capturedUrls: string[] = [];
    stubFetch((url) => {
      capturedUrls.push(url);
      return jsonResponse(emptyAll);
    });

    await fetchAnalyticsPayload({ listIds: [1, 2] });

    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toContain("/analytics/all");
    expect(capturedUrls[0]).toContain("list=1");
    expect(capturedUrls[0]).toContain("list=2");
  });

  it("omits list params when no listIds are given", async () => {
    let capturedUrl = "";
    stubFetch((url) => {
      capturedUrl = url;
      return jsonResponse(emptyAll);
    });

    await fetchAnalyticsPayload();

    expect(capturedUrl).toContain("/analytics/all");
    expect(capturedUrl).not.toContain("list=");
  });
});

describe("createAnalyticsStore.setListFilter", () => {
  it("debounces rapid filter changes into one request", async () => {
    const capturedUrls: string[] = [];
    stubFetch((url) => {
      capturedUrls.push(url);
      return jsonResponse(emptyAll);
    });

    const store = createAnalyticsStore();

    try {
      await store.load();
      capturedUrls.length = 0;

      // Simulate rapid checkbox clicks
      store.setListFilter([1]);
      store.setListFilter([1, 2]);
      store.setListFilter([1, 2, 3]);

      // Wait for debounce to settle
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Only one request should have fired (the last filter state)
      expect(capturedUrls.length).toBe(1);
      expect(capturedUrls[0]).toContain("list=1");
      expect(capturedUrls[0]).toContain("list=2");
      expect(capturedUrls[0]).toContain("list=3");
    } finally {
      store.dispose();
    }
  });

  it("uses no list params for the initial load", async () => {
    const capturedUrls: string[] = [];
    stubFetch((url) => {
      capturedUrls.push(url);
      return jsonResponse(emptyAll);
    });

    const store = createAnalyticsStore();
    try {
      await store.load();
      expect(capturedUrls[0]).not.toContain("list=");
    } finally {
      store.dispose();
    }
  });
});
