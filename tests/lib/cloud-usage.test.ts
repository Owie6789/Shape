import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    USAGE_STALE_MS,
    UsageRefreshScheduler,
    isUsageStale,
    mergeUsageSnapshot,
    usageSnapshotFromAccount,
    usageSnapshotFromCheck,
} from "@/lib/cloud/usage";
import type { AccountSummary } from "@/lib/cloud/account";

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

describe("mergeUsageSnapshot", () => {
    const current = {
        tier: "pro" as const,
        creditsRemaining: 1200,
        creditsIncluded: 1500,
        freeAutoPercent: 18,
        currentPeriodEnd: "2026-11-01T00:00:00.000Z",
    };

    it("returns null when nothing changed so the store can skip the emit", () => {
        expect(mergeUsageSnapshot(current, { ...current })).toBeNull();
        expect(mergeUsageSnapshot(current, { source: "account" })).toBeNull();
        expect(mergeUsageSnapshot(current, { creditsRemaining: Number.NaN })).toBeNull();
    });

    it("returns only the fields that differ", () => {
        expect(mergeUsageSnapshot(current, { creditsRemaining: 900 })).toEqual({
            creditsRemaining: 900,
        });
        expect(
            mergeUsageSnapshot(current, { creditsRemaining: 900, tier: "max", freeAutoPercent: 42 }),
        ).toEqual({ creditsRemaining: 900, tier: "max", freeAutoPercent: 42 });
    });

    it("treats null as an explicit clear for nullable fields", () => {
        expect(mergeUsageSnapshot(current, { freeAutoPercent: null })).toEqual({
            freeAutoPercent: null,
        });
        expect(mergeUsageSnapshot({ freeAutoPercent: null }, { freeAutoPercent: null })).toBeNull();
    });
});

describe("usageSnapshotFromCheck", () => {
    it("carries the fresh balance when the account has a monthly pool", () => {
        expect(
            usageSnapshotFromCheck(
                { creditsIncluded: 1500 },
                { allowed: true, creditsRemaining: 940, tier: "pro" },
            ),
        ).toEqual({ creditsRemaining: 940, tier: "pro", source: "usage-check" });
    });

    it("ignores the balance for accounts with no monthly pool", () => {
        expect(
            usageSnapshotFromCheck(
                { creditsIncluded: 0 },
                { allowed: true, creditsRemaining: 0, tier: "free" },
            ),
        ).toEqual({ tier: "free", source: "usage-check" });
    });

    it("ignores the balance when the check was answered from the on-demand pool", () => {
        expect(
            usageSnapshotFromCheck(
                { creditsIncluded: 1500 },
                { allowed: true, creditsRemaining: 10, tier: "pro", onDemand: true },
            ),
        ).toEqual({ tier: "pro", source: "usage-check" });
    });
});

describe("usageSnapshotFromAccount", () => {
    it("normalises the nullable account fields", () => {
        expect(usageSnapshotFromAccount({ ...ACCOUNT, freeAutoPercent: null })).toEqual({
            tier: "pro",
            creditsRemaining: 1200,
            creditsIncluded: 1500,
            freeAutoPercent: null,
            currentPeriodEnd: "2026-11-01T00:00:00.000Z",
            source: "account",
        });
    });
});

describe("isUsageStale", () => {
    it("treats a missing snapshot as stale", () => {
        expect(isUsageStale(null, 1_000)).toBe(true);
        expect(isUsageStale(undefined, 1_000)).toBe(true);
    });

    it("is fresh inside the window and stale past it", () => {
        expect(isUsageStale(1_000, 1_000 + USAGE_STALE_MS)).toBe(false);
        expect(isUsageStale(1_000, 1_000 + USAGE_STALE_MS + 1)).toBe(true);
    });
});

describe("UsageRefreshScheduler", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("collapses a burst into a single load", async () => {
        const load = vi.fn(async () => {});
        const scheduler = new UsageRefreshScheduler({ load, debounceMs: 100 });

        for (let i = 0; i < 5; i += 1) scheduler.schedule();
        expect(load).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);
        expect(load).toHaveBeenCalledTimes(1);
        expect(scheduler.startedCount).toBe(1);
    });

    it("never overlaps loads, so responses cannot land out of order", async () => {
        const events: string[] = [];
        let release: (() => void) | null = null;
        const load = vi.fn(() => {
            const order = load.mock.calls.length;
            events.push(`start-${order}`);
            if (order === 1) {
                return new Promise<void>((resolve) => {
                    release = () => {
                        events.push("end-1");
                        resolve();
                    };
                });
            }
            events.push(`end-${order}`);
            return Promise.resolve();
        });
        const scheduler = new UsageRefreshScheduler({ load, debounceMs: 10 });

        const first = scheduler.flush();
        scheduler.schedule();
        await vi.advanceTimersByTimeAsync(10);
        // The debounce fired, but the second load must wait for the first.
        expect(load).toHaveBeenCalledTimes(1);

        release?.();
        await first;
        await vi.advanceTimersByTimeAsync(0);

        expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    });

    it("flush skips the debounce and survives a failing load", async () => {
        const load = vi
            .fn<() => Promise<unknown>>()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue(undefined);
        const scheduler = new UsageRefreshScheduler({ load, debounceMs: 500 });

        await expect(scheduler.flush()).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledTimes(1);

        await scheduler.flush();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("stops scheduling after dispose", async () => {
        const load = vi.fn(async () => {});
        const scheduler = new UsageRefreshScheduler({ load, debounceMs: 10 });

        scheduler.schedule();
        scheduler.dispose();
        await vi.advanceTimersByTimeAsync(50);
        expect(load).not.toHaveBeenCalled();

        await scheduler.flush();
        expect(load).not.toHaveBeenCalled();
    });
});
