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
import {
    isUsageStale,
    USAGE_STALE_MS,
    type UsageSnapshot,
} from "@/lib/cloud/usage";

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

    it("ignores an in-flight fetch when another window ends the session", async () => {
        await signIn();

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

        // A second Shape window signs out. This window never calls logoutShape();
        // it only sees the dropped token plus the broadcast, so the in-flight
        // request above was captured against the old session.
        localStorage.removeItem("shape-auth-token");
        window.dispatchEvent(new CustomEvent("shape-auth-changed"));
        await vi.waitFor(() => expect(getShapeAuthState().loggedIn).toBe(false));

        release?.();
        await inFlight;

        expect(getShapeAuthState().loggedIn).toBe(false);
        expect(getShapeAuthState().creditsRemaining).toBe(0);
        expect(getShapeAuthState().email).toBeNull();
    });

    it("still applies the account after a 401 forces a token rotation", async () => {
        await signIn();
        localStorage.setItem("shape-auth-refresh-token", "refresh-1");

        // First account call 401s, the refresh mints a new token, the retry lands.
        let accountCalls = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (/\/api\/account(?!\/)/.test(url)) {
                    accountCalls += 1;
                    if (accountCalls === 1) return jsonReply({ error: "expired" }, 401);
                    return jsonReply({ ...ACCOUNT, creditsRemaining: 999 });
                }
                if (url.includes("/oauth/token")) {
                    return jsonReply({
                        accessToken: "token-2",
                        refreshToken: "refresh-2",
                        user: { id: "user-1", email: "dev@example.com", name: "Dev" },
                        tier: "pro",
                        credits: 999,
                    });
                }
                return jsonReply({});
            }),
        );

        await refreshShapeAuth();

        // If the rotation bumped the session generation and nothing re-captured it,
        // the retry would be dropped and the balance would stay at the old figure.
        expect(accountCalls).toBeGreaterThanOrEqual(2);
        expect(getShapeAuthState().loggedIn).toBe(true);
        expect(getShapeAuthState().creditsRemaining).toBe(999);
        expect(getShapeAuthState().accessToken).toBe("token-2");
    });

    it("stamps a confirmation a usage check returned even when nothing moved", async () => {
        await signIn();
        const before = getShapeAuthState().usageUpdatedAt ?? 0;
        vi.useFakeTimers();
        vi.setSystemTime(before + USAGE_STALE_MS + 1000);

        // The server just agreed with the balance we already had, so the merge
        // finds no field to change. The confirmation still happened, and the
        // figures must not read as stale one tick later.
        applyUsageCheckResult({ allowed: true, creditsRemaining: 1200, tier: "pro" });

        expect(getShapeAuthState().creditsRemaining).toBe(1200);
        expect(getShapeAuthState().usageUpdatedAt).toBeGreaterThan(before);
        expect(isUsageStale(getShapeAuthState().usageUpdatedAt, Date.now())).toBe(false);
        vi.useRealTimers();
    });

    it("does not let an in-flight account response roll back a newer usage check", async () => {
        await signIn();

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let accountStarted = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (/\/api\/account(?!\/)/.test(url)) {
                    accountStarted = true;
                    await gate;
                    // This response left the server before the check below landed.
                    return jsonReply({ ...ACCOUNT, creditsRemaining: 400 });
                }
                return jsonReply({});
            }),
        );

        const pending = refreshShapeAuth();
        await vi.waitFor(() => expect(accountStarted).toBe(true));

        // A usage check confirms a newer balance while that request is in flight.
        applyUsageCheckResult({ allowed: true, creditsRemaining: 900, tier: "pro" });

        release?.();
        await pending;

        expect(getShapeAuthState().creditsRemaining).toBe(900);
    });

    it("refuses a usage check that belongs to a different account", async () => {
        await signIn();

        // Issued for another account before the session switched over here.
        applyUsageCheckResult(
            { allowed: true, creditsRemaining: 730, tier: "pro" },
            "user-2",
        );

        expect(getShapeAuthState().creditsRemaining).toBe(1200);
    });

    it("accepts the same check when the account matches", async () => {
        await signIn();
        applyUsageCheckResult(
            { allowed: true, creditsRemaining: 730, tier: "pro" },
            "user-1",
        );
        expect(getShapeAuthState().creditsRemaining).toBe(730);
    });

    it("drops a peer snapshot from another account", async () => {
        await signIn();

        expect(
            applyUsageSnapshot({ creditsRemaining: 40, userId: "user-2" }),
        ).toBe(false);
        expect(getShapeAuthState().creditsRemaining).toBe(1200);
    });

    it("does not mark the whole snapshot fresh on a tier-only check", async () => {
        await signIn();
        const before = getShapeAuthState().usageUpdatedAt ?? 0;
        vi.useFakeTimers();
        vi.setSystemTime(before + USAGE_STALE_MS + 1000);

        // The check measured the tier and nothing else, so the balance and the
        // reset date are still as old as they were. Claiming otherwise would
        // suppress the focus refresh meant to replace them.
        applyUsageCheckResult({ allowed: true, tier: "enterprise" }, "user-1");

        expect(getShapeAuthState().tier).toBe("enterprise");
        expect(getShapeAuthState().usageUpdatedAt).toBe(before);
        vi.useRealTimers();
    });

    it("drops an in-flight fetch when another window signs in as someone else", async () => {
        await signIn();

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let accountStarted = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (/\/api\/account(?!\/)/.test(url)) {
                    // The token tells the two requests apart: the gated one was
                    // issued for token-1, the retry for token-2.
                    const auth = String(
                        new Headers(init?.headers).get("Authorization") ?? "",
                    );
                    if (auth.includes("token-1")) {
                        accountStarted = true;
                        await gate;
                        return jsonReply({ ...ACCOUNT, email: "old@example.com" });
                    }
                    return jsonReply({ ...ACCOUNT, email: "new@example.com" });
                }
                return jsonReply({});
            }),
        );

        const pending = refreshShapeAuth();
        await vi.waitFor(() => expect(accountStarted).toBe(true));

        // Not a sign-out this time: a different account, signed in elsewhere.
        // The token is still non-null, so only a token comparison catches it.
        localStorage.setItem("shape-auth-token", "token-2");
        window.dispatchEvent(new CustomEvent("shape-auth-changed"));

        // Let the new account land first, then release the stale response so it
        // arrives last. Without the invalidation it would overwrite the account
        // this window has already moved on to.
        await vi.waitFor(() =>
            expect(getShapeAuthState().email).toBe("new@example.com"),
        );

        release?.();
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getShapeAuthState().email).toBe("new@example.com");
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
