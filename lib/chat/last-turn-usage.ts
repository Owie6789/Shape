/** Last completed agent turn usage — drives the composer ring delta (not monthly %). */

export type LastTurnUsage = {
    tokens: number;
    inputTokens: number;
    creditsCharged: number;
    usedAuto: boolean;
    at: number;
    /**
     * Whose turn this was. The record is module-global, so without this a
     * second account signing in inside the TTL would be shown the previous
     * user's last-turn cost.
     */
    userId: string | null;
};

let lastTurn: LastTurnUsage | null = null;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

export function getLastTurnUsage(): LastTurnUsage | null {
    return lastTurn;
}

export function setLastTurnUsage(next: {
    tokens?: number;
    inputTokens?: number;
    creditsCharged?: number;
    usedAuto?: boolean;
    userId?: string | null;
} | null) {
    if (!next) {
        lastTurn = null;
        emit();
        return;
    }
    lastTurn = {
        tokens: next.tokens ?? 0,
        inputTokens: next.inputTokens ?? next.tokens ?? 0,
        creditsCharged: next.creditsCharged ?? 0,
        usedAuto: Boolean(next.usedAuto),
        at: Date.now(),
        userId: next.userId ?? null,
    };
    emit();
}

/** Drop the record. Called when the session ends so it cannot outlive its owner. */
export function clearLastTurnUsage() {
    if (lastTurn === null) return;
    lastTurn = null;
    emit();
}

export function subscribeLastTurnUsage(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
