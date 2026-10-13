import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyUsageCheckResult,
    applyUsageSnapshot,
    getShapeAuthState,
    initShapeAuth,
    logoutShape,
    refreshShapeAuth,
} from "@/lib/cloud/store";
import { checkUsage } from "@/lib/cloud/api";
import type { AccountSummary } from "@/lib/cloud/account";
import { USAGE_STALE_MS, type UsageSnapshot } from "@/lib/cloud/usage";

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

/** Minimal Response stand-in — shapeApiFetch only touches ok / status / json. */
function jsonReply(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function installFetchMock(account: AccountSummary, usageCheck?: unknown) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/account")) return jsonReply(account);
        if (url.includes("/api/usage/check")) {
            return jsonReply(usageCheck ?? { allowed: true, creditsRemaining: 500, tier: "pro" });
        }
        return jsonReply({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

async function signIn(account: AccountSummary = ACCOUNT, usageCheck?: unknown) {
    const fetchMock = installFetchMock(account, usageCheck);
    localStorage.setItem("shape-auth-token", "token-1");
    await initShapeAuth();
    await refreshShapeAuth();
    expect(getShapeAuthState().loggedIn).toBe(true);
    return { state: getShapeAuthState(), fetchMock };
}

/** Counts /api/account only — /api/account/telemetry must not be mistaken for it. */
function accountCallCount(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([u]) => /\/api\/account(?!\/)/.test(String(u))).length;
}

/** Records `shape-usage-changed` dispatches while still delivering them. */
function watchUsageBroadcasts() {
    const seen: UsageSnapshot[] = [];
    const original = window.dispatchEvent.bind(window);
    window.dispatchEvent = (event: Event) => {
        if (event.type === "shape-usage-changed") {
            seen.push((event as CustomEvent<UsageSnapshot>).detail);
        }
        return original(event);
    };
    return { seen, restore: () => { window.dispatchEvent = original; } };
}

describe("cloud usage store fast path", () => {
    beforeEach(async () => {
        vi.unstubAllGlobals();
        if (getShapeAuthState().loggedIn) await logoutShape();
    });

    it("refuses to apply a snapshot while signed out", () => {
        installFetchMock(ACCOUNT);
        expect(getShapeAuthState().loggedIn).toBe(false);
        expect(applyUsageSnapshot({ creditsRemaining: 1 })).toBe(false);
        expect(getShapeAuthState().creditsRemaining).toBe(0);
    });

    it("applies a snapshot to the live store and stamps when it landed", async () => {
        await signIn();
        expect(getShapeAuthState().creditsRemaining).toBe(1200);

        const changed = applyUsageSnapshot({ creditsRemaining: 940 });

        const after = getShapeAuthState();
        expect(changed).toBe(true);
        expect(after.creditsRemaining).toBe(940);
        expect(after.creditsIncluded).toBe(1500);
        expect(typeof after.usageUpdatedAt).toBe("number");
        expect(after.usageUpdatedAt!).toBeGreaterThan(0);
    });

    it("keeps the same snapshot object when nothing changed, so surfaces do not re-render", async () => {
        const { state: before } = await signIn();

        expect(applyUsageSnapshot({ creditsRemaining: 1200 })).toBe(false);
        // useSyncExternalStore compares snapshots by identity: same object means
        // the sidebar ring, composer ring and Settings all skip the render.
        expect(getShapeAuthState()).toBe(before);

        expect(applyUsageSnapshot({ creditsRemaining: 1100 })).toBe(true);
        expect(getShapeAuthState()).not.toBe(before);
        expect(getShapeAuthState().creditsRemaining).toBe(1100);
    });

    it("takes the balance from a usage check without waiting for a poll", async () => {
        await signIn();
        applyUsageCheckResult({ allowed: true, creditsRemaining: 730, tier: "pro" });
        expect(getShapeAuthState().creditsRemaining).toBe(730);
    });

    it("feeds the store from the /usage/check call the UI already makes", async () => {
        await signIn(ACCOUNT, { allowed: true, creditsRemaining: 610, tier: "pro" });
        expect(getShapeAuthState().creditsRemaining).toBe(1200);

        const result = await checkUsage("token-1", "anthropic/claude-sonnet-4");

        expect(result.creditsRemaining).toBe(610);
        // The tap is a floating promise; let it land.
        await vi.waitFor(() => {
            expect(getShapeAuthState().creditsRemaining).toBe(610);
        });
    });

    it("adopts a snapshot broadcast by another Shape window without echoing it", async () => {
        await signIn();
        const { seen, restore } = watchUsageBroadcasts();

        window.dispatchEvent(
            new CustomEvent("shape-usage-changed", {
                detail: { creditsRemaining: 321, freeAutoPercent: 44, source: "account" },
            }),
        );

        expect(getShapeAuthState().creditsRemaining).toBe(321);
        expect(getShapeAuthState().freeAutoPercent).toBe(44);
        // Only the dispatch this test made — a re-broadcast would loop forever
        // between windows.
        expect(seen).toHaveLength(1);
        restore();
    });

    it("refreshes on focus only once the snapshot has aged out", async () => {
        const { fetchMock } = await signIn();

        vi.useFakeTimers();
        try {
            const baseline = accountCallCount(fetchMock);

            // The snapshot was just confirmed, so a focus event must not refetch.
            window.dispatchEvent(new Event("focus"));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(accountCallCount(fetchMock)).toBe(baseline);

            // Age it past the staleness window; now focus has to go to the server.
            vi.setSystemTime(Date.now() + USAGE_STALE_MS + 1_000);
            window.dispatchEvent(new Event("focus"));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(accountCallCount(fetchMock)).toBe(baseline + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("drops an out-of-order snapshot from another window", async () => {
        await signIn();

        const older = { creditsRemaining: 1_000, freeAutoPercent: 20, origin: "win-b", seq: 1 };
        const newer = { creditsRemaining: 400, freeAutoPercent: 61, origin: "win-b", seq: 2 };

        window.dispatchEvent(new CustomEvent("shape-usage-changed", { detail: newer }));
        expect(getShapeAuthState().creditsRemaining).toBe(400);

        // Tauri dispatches each emit as its own task, so seq 1 can land second.
        window.dispatchEvent(new CustomEvent("shape-usage-changed", { detail: older }));

        expect(getShapeAuthState().creditsRemaining).toBe(400);
        expect(getShapeAuthState().freeAutoPercent).toBe(61);
    });

    it("still accepts a newer snapshot from the same window afterwards", async () => {
        await signIn();

        window.dispatchEvent(
            new CustomEvent("shape-usage-changed", {
                detail: { creditsRemaining: 400, origin: "win-c", seq: 2 },
            }),
        );
        window.dispatchEvent(
            new CustomEvent("shape-usage-changed", {
                detail: { creditsRemaining: 250, origin: "win-c", seq: 3 },
            }),
        );

        expect(getShapeAuthState().creditsRemaining).toBe(250);
    });

    it("does not let an in-flight account fetch resurrect a signed-out session", async () => {
        await signIn();

        // An account request that only settles once the test releases it.
        let release: (() => void) | null = null;
        let accountStarted = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (/\/api\/account(?!\/)/.test(url)) {
                    accountStarted = true;
                    await gate;
                    return jsonReply(ACCOUNT);
                }
                return jsonReply({});
            }),
        );

        const inFlight = refreshShapeAuth();
        await vi.waitFor(() => expect(accountStarted).toBe(true));

        // Sign out while that refresh is still in flight.
        await logoutShape();
        expect(getShapeAuthState().loggedIn).toBe(false);

        release?.();
        await inFlight;

        // The stale response lands after sign-out and must be ignored.
        expect(getShapeAuthState().loggedIn).toBe(false);
        expect(getShapeAuthState().creditsRemaining).toBe(0);
        expect(getShapeAuthState().email).toBeNull();
        expect(getShapeAuthState().accessToken).toBeNull();
    });

    it("rebroadcasts a snapshot it produced itself so other windows catch up", async () => {
        await signIn();
        const { seen, restore } = watchUsageBroadcasts();

        applyUsageSnapshot({ creditsRemaining: 880 });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ creditsRemaining: 880 });
        restore();
    });
});
