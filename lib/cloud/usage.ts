import type { UsageCheckResult, ShapeTier } from "./types";
import type { AccountSummary } from "./account";

/**
 * Usage-limit freshness policy.
 *
 * Credit and Auto-limit numbers live in the cloud auth store and feed every
 * usage surface: the sidebar ring, the composer ring, and Settings → Account.
 * They used to arrive one way only — a full `GET /api/account` on a 30 minute
 * timer. Anything that happened in between stayed stale, a refresh in one Shape
 * window never reached the others, and concurrent refreshes could land out of
 * order.
 *
 * This module is the fast path:
 *
 * 1. `mergeUsageSnapshot` folds any partial usage payload into the store the
 *    moment it is known, including the numbers `POST /api/usage/check` already
 *    returns on the hot path and that used to be discarded.
 * 2. `UsageRefreshScheduler` serialises and coalesces account refreshes, so a
 *    burst of agent turns costs one request instead of one per turn, and a slow
 *    response can never overwrite a newer one.
 * 3. `isUsageStale` decides when a focus / visibility event is worth a request,
 *    which is what keeps the cheap path cheap.
 */

/** Snapshot older than this is refetched when the window becomes usable again. */
export const USAGE_STALE_MS = 30_000;

/** Burst window: refreshes requested inside it collapse into one request. */
export const USAGE_REFRESH_DEBOUNCE_MS = 800;

/** Where a snapshot's numbers came from. Diagnostic only — never gates logic. */
export type UsageSnapshotSource = "account" | "usage-check" | "peer-window";

export type UsageSnapshotFields = {
  tier?: ShapeTier;
  creditsRemaining?: number;
  creditsIncluded?: number;
  freeAutoPercent?: number | null;
  currentPeriodEnd?: string | null;
};

export type UsageSnapshot = UsageSnapshotFields & {
  source?: UsageSnapshotSource;
  /**
   * Account the figures belong to. Snapshots travel between windows and back
   * from in-flight requests, so a session change has to be detectable.
   */
  userId?: string;
  /** Producer clock, ms epoch. Informational — clocks differ between windows. */
  at?: number;
  /** Producer-local monotonic counter. */
  seq?: number;
  /** Producer id, so counters from different windows never collide. */
  origin?: string;
};

function isUsableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reduce an incoming snapshot to the fields that actually differ.
 *
 * Returns `null` when nothing changed so callers can skip the store emit —
 * without that, every idle poll re-renders each usage surface for no reason.
 */
export function mergeUsageSnapshot(
  current: UsageSnapshotFields,
  next: UsageSnapshot,
): UsageSnapshotFields | null {
  const patch: UsageSnapshotFields = {};
  let changed = false;

  if (next.tier !== undefined && next.tier !== current.tier) {
    patch.tier = next.tier;
    changed = true;
  }
  if (
    isUsableNumber(next.creditsRemaining)
    && next.creditsRemaining !== current.creditsRemaining
  ) {
    patch.creditsRemaining = next.creditsRemaining;
    changed = true;
  }
  if (
    isUsableNumber(next.creditsIncluded)
    && next.creditsIncluded !== current.creditsIncluded
  ) {
    patch.creditsIncluded = next.creditsIncluded;
    changed = true;
  }
  if (
    (isUsableNumber(next.freeAutoPercent) || next.freeAutoPercent === null)
    && next.freeAutoPercent !== current.freeAutoPercent
  ) {
    patch.freeAutoPercent = next.freeAutoPercent;
    changed = true;
  }
  if (
    (typeof next.currentPeriodEnd === "string" || next.currentPeriodEnd === null)
    && next.currentPeriodEnd !== current.currentPeriodEnd
  ) {
    patch.currentPeriodEnd = next.currentPeriodEnd;
    changed = true;
  }

  return changed ? patch : null;
}

export function usageSnapshotFromAccount(account: AccountSummary): UsageSnapshot {
  return {
    tier: account.tier,
    creditsRemaining: account.creditsRemaining,
    creditsIncluded: account.creditsIncluded,
    freeAutoPercent: account.freeAutoPercent ?? null,
    currentPeriodEnd: account.currentPeriodEnd ?? null,
    source: "account",
    userId: account.id,
  };
}

/**
 * Lift the usage fields out of a `/api/usage/check` response.
 *
 * That call already runs before every gated AI action, so its numbers cost
 * nothing extra — but they describe whichever pool the check measured, so they
 * are applied only when the account shows a monthly credit balance, and never
 * when the check was answered from the on-demand pool.
 */
export function usageSnapshotFromCheck(
  current: UsageSnapshotFields,
  check: UsageCheckResult,
): UsageSnapshot {
  const snapshot: UsageSnapshot = { source: "usage-check" };
  if (check.tier) snapshot.tier = check.tier;
  const hasMonthlyCredits =
    isUsableNumber(current.creditsIncluded) && current.creditsIncluded > 0;
  if (hasMonthlyCredits && !check.onDemand && isUsableNumber(check.creditsRemaining)) {
    snapshot.creditsRemaining = check.creditsRemaining;
  }
  return snapshot;
}

/** True when the snapshot is missing or older than `maxAgeMs`. */
export function isUsageStale(
  usageUpdatedAt: number | null | undefined,
  now: number,
  maxAgeMs: number = USAGE_STALE_MS,
): boolean {
  if (typeof usageUpdatedAt !== "number" || !Number.isFinite(usageUpdatedAt)) return true;
  return now - usageUpdatedAt > maxAgeMs;
}

/** Stamp a snapshot for broadcast so receivers can reject out-of-order copies. */
export function stampUsageSnapshot(
  snapshot: UsageSnapshot,
  stamp: { origin: string; seq: number; at: number },
): UsageSnapshot {
  return { ...snapshot, origin: stamp.origin, seq: stamp.seq, at: stamp.at };
}

/**
 * True when this snapshot is older than one already applied from the same
 * origin.
 *
 * Tauri dispatches every `emit` as its own task, so two snapshots sent back to
 * back can reach another window in either order. Without this, a stale balance
 * could overwrite the fresh one and the ring would sit wrong until the next
 * poll. Unversioned snapshots are applied — better late data than none.
 */
export function isStalePeerSnapshot(
  seen: ReadonlyMap<string, number>,
  snapshot: UsageSnapshot,
): boolean {
  const { origin, seq } = snapshot;
  if (!origin || typeof seq !== "number" || !Number.isFinite(seq)) return false;
  const last = seen.get(origin);
  return typeof last === "number" && seq <= last;
}

/** Remember the newest seq seen from an origin. */
export function recordPeerSnapshot(
  seen: Map<string, number>,
  snapshot: UsageSnapshot,
): void {
  const { origin, seq } = snapshot;
  if (!origin || typeof seq !== "number" || !Number.isFinite(seq)) return;
  seen.set(origin, seq);
}

/** Human age of the current numbers, for the surfaces that show raw figures. */
export function formatUsageFreshness(
  usageUpdatedAt: number | null | undefined,
  now: number,
): string {
  if (typeof usageUpdatedAt !== "number" || !Number.isFinite(usageUpdatedAt)) {
    return "Not synced yet";
  }
  const secs = Math.max(0, Math.round((now - usageUpdatedAt) / 1000));
  if (secs < 5) return "Updated just now";
  if (secs < 60) return `Updated ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

/**
 * Serialising, coalescing driver for account refreshes.
 *
 * Every load starts only after the previous one settles, so two responses can
 * never write to the store out of order, and callers may fire it as often as
 * they like: `schedule()` collapses a burst into a single request.
 */
export class UsageRefreshScheduler {
  readonly #load: () => Promise<unknown>;
  readonly #debounceMs: number;
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #queued = false;
  #started = 0;
  #disposed = false;

  constructor(opts: { load: () => Promise<unknown>; debounceMs?: number }) {
    this.#load = opts.load;
    this.#debounceMs = Math.max(0, opts.debounceMs ?? USAGE_REFRESH_DEBOUNCE_MS);
  }

  /** A load is in flight right now. */
  get busy(): boolean {
    return this.#running;
  }

  /** A debounced load is queued. */
  get scheduled(): boolean {
    return this.#timer !== null;
  }

  /** How many loads this scheduler actually started. */
  get startedCount(): number {
    return this.#started;
  }

  /** Queue a refresh; repeated calls inside the debounce window collapse. */
  schedule(): void {
    if (this.#disposed) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, this.#debounceMs);
  }

  /** Refresh now, skipping the debounce. Still serialised behind a live load. */
  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#run();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #run(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    // A load is in flight and another is already waiting behind it. Collapsing
    // here means a burst of events during a slow request costs one follow-up
    // refresh instead of one per event.
    if (this.#running && this.#queued) return this.#chain;
    this.#queued = true;
    const next = this.#chain.then(async () => {
      if (this.#disposed) return;
      this.#queued = false;
      this.#started += 1;
      this.#running = true;
      try {
        await this.#load();
      } catch {
        // The loader reports its own errors (offline, expired session).
      } finally {
        this.#running = false;
      }
    });
    this.#chain = next;
    return next;
  }
}
