const STORAGE_KEY = "shape-trusted-workspaces";

function normalizeWorkspacePath(path: string): string {
    const trimmed = path.trim().replace(/[\\/]+$/, "");
    const slashed = trimmed.replace(/\\/g, "/");
    return /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\") ? slashed.toLowerCase() : slashed;
}

function loadTrustedSet(): Set<string> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.map((p) => normalizeWorkspacePath(String(p))));
    } catch {
        return new Set();
    }
}

function saveTrustedSet(set: Set<string>): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

const trustQueues = new Map<string, Promise<void>>();
function syncRustTrust(path: string, trusted: boolean): Promise<void> {
    const k = normalizeWorkspacePath(path), n = (trustQueues.get(k) ?? Promise.resolve()).then(() => import("@/lib/backend").then(({ commands: c }) => c.setWorkspaceTrusted(path, trusted).catch(() => c.setWorkspaceTrusted(path, trusted))).then(() => undefined).catch((err) => console.error("Trust sync failed", { trusted, err })));
    trustQueues.set(k, n);
    return n;
}

export function isWorkspaceTrusted(path: string | null | undefined): boolean {
    if (!path) return false;
    return loadTrustedSet().has(normalizeWorkspacePath(path));
}

export function trustWorkspace(path: string): void {
    const set = loadTrustedSet();
    set.add(normalizeWorkspacePath(path));
    saveTrustedSet(set);
    void syncRustTrust(path, true);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("shape-workspace-trusted", { detail: { path } }));
    }
}

export function untrustWorkspace(path: string): void {
    const set = loadTrustedSet();
    set.delete(normalizeWorkspacePath(path));
    saveTrustedSet(set);
    void syncRustTrust(path, false);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("shape-workspace-untrusted", { detail: { path } }));
}

export function listTrustedWorkspaces(): string[] {
    return [...loadTrustedSet()];
}

export async function ensureWorkspaceTrust(path: string): Promise<boolean> {
    if (isWorkspaceTrusted(path)) { await syncRustTrust(path, true); return true; }
    try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        if (await confirm(`Trust this workspace?\n\n${path}`, { title: "Trust workspace", kind: "warning", okLabel: "Trust", cancelLabel: "Open untrusted" })) { trustWorkspace(path); await syncRustTrust(path, true); return true; }
    } catch {}
    await syncRustTrust(path, false); return false;
}

export function notifyWorkspaceOpened(path: string): void {
    if (typeof window === "undefined") return;
    void syncRustTrust(path, isWorkspaceTrusted(path));
    window.dispatchEvent(new CustomEvent("shape-workspace-opened", { detail: { path } }));
    if (!isWorkspaceTrusted(path)) window.dispatchEvent(new CustomEvent("shape-workspace-trust-required", { detail: { path } }));
}

export function notifyWorkspaceClosed(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("shape-workspace-opened", { detail: { path: null } }));
}

export { normalizeWorkspacePath };
