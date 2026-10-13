import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatUsageButton } from "@/features/chat/ui/composer/usage";
import {
    applyUsageCheckResult,
    applyUsageSnapshot,
    getShapeAuthState,
    initShapeAuth,
    logoutShape,
    refreshShapeAuth,
} from "@/lib/cloud/store";
import { updateSettingSection } from "@/lib/settings";
import { setLastTurnUsage } from "@/lib/chat/last-turn-usage";
import type { AccountSummary } from "@/lib/cloud/account";

/**
 * Drives the real sidebar ring against the real cloud store, so "the UI updates
 * without waiting for the next poll" is checked on the surface users look at
 * rather than only on store internals.
 *
 * The ring shows the Auto percentage while Auto is selected (the default model)
 * and the credit burn on a premium model.
 */

const ACCOUNT: AccountSummary = {
    id: "user-1",
    email: "dev@example.com",
    name: "Dev",
    tier: "pro",
    creditsRemaining: 1200,
    creditsIncluded: 1500,
    freeAutoPercent: 18,
    currentPeriodEnd: "2026-11-01T00:00:00.000Z",
};

const PREMIUM_MODEL = "anthropic/claude-sonnet-4";

function jsonReply(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
}

function mockCloud(account: AccountSummary = ACCOUNT) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (/\/api\/account(?!\/)/.test(url)) return jsonReply(account);
        if (url.includes("/api/usage/check")) {
            return jsonReply({ allowed: true, creditsRemaining: 500, tier: "pro" });
        }
        return jsonReply({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountSignedInRing(model: string, account?: AccountSummary) {
    mockCloud(account);
    localStorage.setItem("shape-auth-token", "token-1");
    updateSettingSection("ai", { defaultModel: model });

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root?.render(<ChatUsageButton />);
    });
    await act(async () => {
        await initShapeAuth();
        await refreshShapeAuth();
    });
    return host;
}

function unmountRing() {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
}

/** The percentage rendered beside the ring. */
function shownPercent(el: HTMLElement): string {
    return el.querySelector("span.tabular-nums")?.textContent ?? "";
}

/** The ring's accessible name carries the full tooltip. */
function tooltip(el: HTMLElement): string {
    return el.querySelector("button")?.getAttribute("aria-label") ?? "";
}

function arcClass(el: HTMLElement): string {
    return el.querySelectorAll("svg circle")[1]?.getAttribute("class") ?? "";
}

describe("sidebar usage ring", () => {
    beforeEach(async () => {
        vi.unstubAllGlobals();
        if (getShapeAuthState().loggedIn) await logoutShape();
        setLastTurnUsage(null);
        updateSettingSection("ai", { defaultModel: "auto" });
    });

    afterEach(() => {
        unmountRing();
    });

    it("stays neutral while auth resolves, then invites a sign-in", async () => {
        const fetchMock = mockCloud();
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => {
            root?.render(<ChatUsageButton />);
        });

        // Loading: no claim about the account yet.
        expect(tooltip(host)).toBe("Usage");

        await act(async () => {
            await initShapeAuth();
            await refreshShapeAuth();
        });

        expect(getShapeAuthState().loggedIn).toBe(false);
        expect(tooltip(host)).toBe("Sign in to view usage");
        // Boot fetches the catalog and runtime, but never the account itself.
        const called = fetchMock.mock.calls.map(([u]) => String(u));
        expect(called.some((u) => /\/api\/account(?!\/)/.test(u))).toBe(false);
    });

    it("paints the Auto percentage once the account lands", async () => {
        const el = await mountSignedInRing("auto");
        expect(shownPercent(el)).toBe("18%");
        expect(tooltip(el)).toBe("18% used this month (Auto)");
    });

    it("paints the credit burn on a premium model", async () => {
        const el = await mountSignedInRing(PREMIUM_MODEL);
        // 300 of 1500 used.
        expect(shownPercent(el)).toBe("20%");
    });

    it("moves the moment a usage snapshot lands, with no extra request", async () => {
        const fetchMock = mockCloud();
        localStorage.setItem("shape-auth-token", "token-1");
        updateSettingSection("ai", { defaultModel: PREMIUM_MODEL });

        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => {
            root?.render(<ChatUsageButton />);
        });
        await act(async () => {
            await initShapeAuth();
            await refreshShapeAuth();
        });
        expect(shownPercent(host)).toBe("20%");
        const callsAfterSignIn = fetchMock.mock.calls.length;

        act(() => {
            applyUsageSnapshot({ creditsRemaining: 450 });
        });

        expect(shownPercent(host)).toBe("70%");
        // The surface repainted with no network round trip at all.
        expect(fetchMock.mock.calls.length).toBe(callsAfterSignIn);
    });

    it("updates from a usage-check result the app already fetched", async () => {
        const el = await mountSignedInRing(PREMIUM_MODEL);

        act(() => {
            applyUsageCheckResult({ allowed: true, creditsRemaining: 150, tier: "pro" });
        });

        expect(shownPercent(el)).toBe("90%");
    });

    it("adopts another window's snapshot in the same tick", async () => {
        const el = await mountSignedInRing(PREMIUM_MODEL);

        act(() => {
            window.dispatchEvent(
                new CustomEvent("shape-usage-changed", {
                    detail: { creditsRemaining: 1350, origin: "other-window", seq: 1 },
                }),
            );
        });

        expect(shownPercent(el)).toBe("10%");
    });

    it("ignores a late snapshot that another window already superseded", async () => {
        const el = await mountSignedInRing(PREMIUM_MODEL);
        const send = (seq: number, creditsRemaining: number) =>
            act(() => {
                window.dispatchEvent(
                    new CustomEvent("shape-usage-changed", {
                        detail: { creditsRemaining, origin: "other-window", seq },
                    }),
                );
            });

        send(2, 1350);
        expect(shownPercent(el)).toBe("10%");

        send(1, 300);
        expect(shownPercent(el)).toBe("10%");
    });

    it("shows what the last turn cost in the tooltip", async () => {
        const el = await mountSignedInRing("auto");
        expect(tooltip(el)).toBe("18% used this month (Auto)");

        act(() => {
            setLastTurnUsage({ tokens: 8_200, creditsCharged: 0, usedAuto: true });
        });

        expect(tooltip(el)).toBe("18% used this month (Auto) · +8,200 tokens last turn");
    });

    it("switches to the warning colour as the limit approaches", async () => {
        const el = await mountSignedInRing(PREMIUM_MODEL);
        expect(arcClass(el)).toContain("text-accent");

        act(() => {
            applyUsageSnapshot({ creditsRemaining: 100 });
        });

        expect(shownPercent(el)).toBe("93%");
        expect(arcClass(el)).toContain("text-warning");
    });
});
