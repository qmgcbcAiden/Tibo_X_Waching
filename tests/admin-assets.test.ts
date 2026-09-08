import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_JS } from "../src/admin-assets.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("admin analysis stream state", () => {
  it("keeps an expanded timeline open and cached across periodic list replacement", async () => {
    const { window, document } = parseHTML(`<!doctype html><html><head>
      <meta name="csrf-token" content="test">
      </head><body>
      <section class="column"><div data-analyses></div><button data-load-more></button></section>
      </body></html>`);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    let intervalCallback: (() => void) | null = null;
    let listCalls = 0;
    let detailCalls = 0;
    const item = {
      activityKind: "probe",
      tweetId: "probe:42",
      url: "",
      postedAt: "2026-09-01T08:00:00.000Z",
      cleanText: "可用 1/2 源 · 合并 20 条 · 新增 0 条",
      verdict: null,
      eventType: null,
      confidence: null,
      model: null,
      failed: false,
      flashEscalated: false,
      probeStatus: "partial"
    };
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url === "/api/status") {
          return {
            status: {
              watcher: "healthy",
              x: { active: false },
              deepseek: { active: false },
              copywriter: { active: false },
              availableSourceCount: 1,
              enabledSourceCount: 2,
              pollOverdue: false,
              lastPollAt: null,
              nextPollAt: null,
              nextReminder: null,
              today: {}
            },
            users: []
          };
        }
        if (url.startsWith("/api/analyses?")) {
          listCalls += 1;
          return { items: [{ ...item, cleanText: `${item.cleanText} · 刷新${listCalls}` }], nextCursor: null };
        }
        detailCalls += 1;
        return {
          kind: "probe",
          probe: {
            id: 42, startedAt: item.postedAt, completedAt: item.postedAt,
            status: "partial", durationMs: 1000, enabledSources: ["x_browser", "feedly_xcancel"],
            enabledSourceCount: 2, successfulSourceCount: 1, totalItemCount: 20,
            uniqueItemCount: 20, crossSourceDuplicateCount: 0, existingCount: 20,
            newCount: 0, classifiableCount: 0, replyCount: 0, repostCount: 0,
            quoteCount: 0, staleCount: 0, otherExcludedCount: 0,
            classificationSuccessCount: 0, classificationFailureCount: 0, error: null
          },
          sources: [],
          interruptionMinutes: null
        };
      }
    })) as unknown as typeof fetch;
    const run = new Function(
      "window", "document", "fetch", "setInterval", "requestAnimationFrame", "location",
      ADMIN_JS
    );
    run(
      window,
      document,
      fetchImpl,
      (callback: () => void) => { intervalCallback = callback; return 1; },
      (callback: () => void) => { callback(); return 1; },
      { href: "" }
    );
    const fireInterval = (): void => {
      if (!intervalCallback) throw new Error("refresh interval was not registered");
      intervalCallback();
    };
    await flush();

    const firstCard = document.querySelector<HTMLElement>("[data-analysis]")!;
    firstCard.querySelector<HTMLElement>('[data-action="detail"]')!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush();
    expect(firstCard.querySelector<HTMLElement>(".timeline")!.hidden).toBe(false);
    expect(firstCard.textContent).toContain("探测周期");
    expect(detailCalls).toBe(1);

    fireInterval();
    await flush();
    const refreshedCard = document.querySelector<HTMLElement>("[data-analysis]")!;
    expect(refreshedCard).not.toBe(firstCard);
    expect(refreshedCard.querySelector<HTMLElement>(".timeline")!.hidden).toBe(false);
    expect(refreshedCard.querySelector('[data-action="detail"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(refreshedCard.textContent).toContain("探测周期");
    expect(detailCalls).toBe(1);

    refreshedCard.querySelector<HTMLElement>('[data-action="detail"]')!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(refreshedCard.querySelector<HTMLElement>(".timeline")!.hidden).toBe(true);
    fireInterval();
    await flush();
    expect(document.querySelector<HTMLElement>(".timeline")!.hidden).toBe(true);
  });
});
