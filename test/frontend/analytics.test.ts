import { afterEach, describe, expect, it } from "bun:test";
import { fetchAnalyticsPayload, createAnalyticsStore } from "../../src/frontend/lib/analytics";
import { getAnalyticsByDow, getAnalyticsByHour, getAnalyticsByMonth, getAnalyticsSummary, getAnalyticsTopSenders } from "../../src/frontend/lib/api";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const emptySummary = { totalMessages: 0, totalThreads: 0, uniqueSenders: 0, monthsIngested: 0 };

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
  it("forwards list IDs to all five analytics requests", async () => {
    const capturedUrls: string[] = [];
    stubFetch((url) => {
      capturedUrls.push(url);
      return url.includes("summary") ? jsonResponse(emptySummary) : jsonResponse([]);
    });

    await fetchAnalyticsPayload({ listIds: [1, 2] });

    expect(capturedUrls.length).toBe(5);
    expect(capturedUrls.every((url) => url.includes("list=1") && url.includes("list=2"))).toBe(true);
  });

  it("omits list params when no listIds are given", async () => {
    const capturedUrls: string[] = [];
    stubFetch((url) => {
      capturedUrls.push(url);
      return url.includes("summary") ? jsonResponse(emptySummary) : jsonResponse([]);
    });

    await fetchAnalyticsPayload();

    expect(capturedUrls.every((url) => !url.includes("list="))).toBe(true);
  });
});

describe("createAnalyticsStore.setListFilter", () => {
  it("reloads with the new filter applied to all requests", async () => {
    const urlsByLoad: string[][] = [];
    let currentBatch: string[] = [];
    let batchCount = 0;

    stubFetch((url) => {
      currentBatch.push(url);
      // Each load makes 5 requests; collect into batches
      if (currentBatch.length === 5) {
        urlsByLoad.push(currentBatch);
        currentBatch = [];
        batchCount++;
      }
      return url.includes("summary") ? jsonResponse(emptySummary) : jsonResponse([]);
    });

    const store = createAnalyticsStore();

    try {
      await store.load();
      await store.setListFilter([5]);

      expect(urlsByLoad.length).toBe(2);
      // Initial load: no list params
      expect(urlsByLoad[0]!.every((url) => !url.includes("list="))).toBe(true);
      // After setListFilter: all requests include the list param
      expect(urlsByLoad[1]!.every((url) => url.includes("list=5"))).toBe(true);
    } finally {
      store.dispose();
    }
  });
});
