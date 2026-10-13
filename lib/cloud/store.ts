import { useSyncExternalStore } from "react";
import { commands } from "@/lib/backend/commands";
import {
  dashboardUrl,
  exchangeOAuthCode,
  fetchAccount,
  oauthAuthorizeUrl,
  pollOAuthCode,
  refreshAccessToken,
  revokeToken,
  ShapeApiError,
  websiteLoginUrl,
  websiteProviderSignInUrl,
} from "./api";
import type { ShapeAuthState, ShapeTier, UsageCheckResult } from "./types";
import { clearShapeCatalog, refreshShapeCatalog } from "@/lib/catalog/store";
import { refreshShapeRuntime } from "@/lib/runtime/store";
import { identifyTelemetryUser } from "@/lib/telemetry";
import { clearLastTurnUsage } from "@/lib/chat/last-turn-usage";
import {
  USAGE_STALE_MS,
  UsageRefreshScheduler,
  isStalePeerSnapshot,
  isUsageStale,
  mergeUsageSnapshot,
  recordPeerSnapshot,
  stampUsageSnapshot,
  usageSnapshotFromAccount,
  usageSnapshotFromCheck,
  type UsageSnapshot,
} from "./usage";

const STORAGE_KEY = "shape-auth-token";
const REFRESH_KEY = "shape-auth-refresh-token";
const PROFILE_KEY = "shape-auth-profile";
const PENDING_OAUTH_KEY = "shape-auth-pending-oauth";
const REDIRECT_URI = "shape://auth/callback";
/** Matches the website OAuth code lifetime so a slow browser sign-in still has its PKCE verifier. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_BASE_MS = 1000;
const LOGIN_POLL_MAX_MS = 8000;
/** How often the IDE refreshes /api/account while signed in. Keep high to reduce Vercel Fluid CPU. */
const REVALIDATE_INTERVAL_MS = 30 * 60 * 1000;
/** Carries fresh usage numbers between Shape windows so no surface stays behind. */
const USAGE_EVENT = "shape-usage-changed";

type PendingOAuth = {
  state: string;
  codeVerifier: string;
  startedAt: number;
};

type CachedProfile = {
  userId: string;
  email: string;
  name: string | null;
  tier: ShapeTier;
  creditsRemaining: number;
  creditsIncluded: number;
  freeAutoPercent: number | null;
  currentPeriodEnd?: string | null;
  cachedAt: number;
};

const DEFAULT_STATE: ShapeAuthState = {
  loggedIn: false,
  isLoggingIn: false,
  isLoading: true,
  offline: false,
  revalidating: false,
  error: null,
  userId: null,
  email: null,
  name: null,
  tier: "free",
  creditsRemaining: 0,
  creditsIncluded: 0,
  freeAutoPercent: null,
  currentPeriodEnd: null,
  usageUpdatedAt: null,
  accessToken: null,
};

let state: ShapeAuthState = { ...DEFAULT_STATE };
const listeners = new Set<() => void>();
let initialized = false;
let pendingState: string | null = null;
let pendingCodeVerifier: string | null = null;
let loginPollTimer: ReturnType<typeof setTimeout> | null = null;
let finishingOAuth = false;
/** Prevents poll + deep-link from exchanging the same one-time code twice. */
let finishedOAuthCode: string | null = null;
let pollAttempt = 0;
/** Bumped so in-flight polls cannot re-arm after success/cancel. */
let loginPollGeneration = 0;
let loginWaiter: ((success: boolean) => void) | null = null;
let revalidateTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<string | null> | null = null;
/**
 * Serialised account refreshes. Usage-changing events fire as often as they
 * like; the scheduler collapses a burst into one request and never lets two
 * responses race.
 */
const usageScheduler = new UsageRefreshScheduler({ load: () => loadAccountUsage() });
/** Identifies this window in usage broadcasts so peers can order them. */
const usageOriginId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `win-${Math.random().toString(36).slice(2)}`;
let usageSeq = 0;
/** Newest seq applied per origin window — rejects out-of-order Tauri emits. */
const peerUsageSeq = new Map<string, number>();
/** Bumped on every token change so in-flight fetches cannot resurrect a session. */
let sessionGeneration = 0;

function settleLoginWaiter(success: boolean) {
  if (!loginWaiter) return;
  loginWaiter(success);
  loginWaiter = null;
}

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ShapeAuthState {
  return state;
}

function setState(patch: Partial<ShapeAuthState>) {
  state = { ...state, ...patch };
  emit();
}

function reportAuthError(message: string) {
  setState({ isLoggingIn: false, error: message });
  void import("@/features/notifications").then(({ notify }) => {
    if (/cancel/i.test(message)) {
      notify.info("Shape", message);
    } else {
      void import("@/lib/errors/catalog").then(({ SHAPE_ERRORS, getError }) => {
        const entry = getError(SHAPE_ERRORS.SIGN_IN_FAILED);
        notify.error(entry.title, message.trim() || entry.description, { code: entry.code });
      });
    }
  });
}

function clearLoginPoll() {
  if (loginPollTimer !== null) {
    clearTimeout(loginPollTimer);
    loginPollTimer = null;
  }
  pollAttempt = 0;
  loginPollGeneration += 1;
}

function savePendingOAuth(oauthState: string, codeVerifier: string) {
  try {
    const payload: PendingOAuth = {
      state: oauthState,
      codeVerifier,
      startedAt: Date.now(),
    };
    localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearPendingOAuth() {
  try {
    localStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* ignore */
  }
}

function loadPendingOAuth(): PendingOAuth | null {
  try {
    const raw = localStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingOAuth;
    if (!parsed?.state || !parsed?.codeVerifier || typeof parsed.startedAt !== "number") {
      clearPendingOAuth();
      return null;
    }
    if (Date.now() - parsed.startedAt > LOGIN_TIMEOUT_MS + 30_000) {
      clearPendingOAuth();
      return null;
    }
    return parsed;
  } catch {
    clearPendingOAuth();
    return null;
  }
}

/** Restore PKCE state after a hot reload / app rebuild mid sign-in. */
function ensurePendingOAuthLoaded() {
  if (pendingState && pendingCodeVerifier) return;
  const saved = loadPendingOAuth();
  if (!saved) return;
  pendingState = saved.state;
  pendingCodeVerifier = saved.codeVerifier;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createPkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

async function loadToken(): Promise<string | null> {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadCachedProfile(): CachedProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProfile;
    if (!parsed?.userId || !parsed?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedProfile(profile: CachedProfile | null) {
  try {
    if (profile) {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } else {
      localStorage.removeItem(PROFILE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Fold a partial usage patch into the stored profile without a full rewrite. */
function patchCachedProfile(patch: Partial<CachedProfile>) {
  const existing = loadCachedProfile();
  if (!existing) return;
  saveCachedProfile({ ...existing, ...patch, cachedAt: Date.now() });
}

/**
 * Apply fresh usage numbers as soon as any caller has them.
 *
 * This is what makes the sidebar, the composer ring and Settings move in the
 * same tick instead of waiting for the next account poll. Returns `true` when
 * something actually changed — an unchanged snapshot never emits, so idle polls
 * do not re-render every usage surface.
 */
export function applyUsageSnapshot(
  snapshot: UsageSnapshot,
  opts: { broadcast?: boolean } = {},
): boolean {
  const { broadcast = true } = opts;
  if (!state.loggedIn) return false;

  const patch = mergeUsageSnapshot(state, snapshot);
  if (!patch) return false;

  setState({ ...patch, usageUpdatedAt: Date.now() });
  patchCachedProfile(patch);
  if (broadcast) broadcastUsageChange(snapshot);
  return true;
}

/** Numbers from a `/api/usage/check` call — already paid for, so never dropped. */
export function applyUsageCheckResult(check: UsageCheckResult): void {
  applyUsageSnapshot(usageSnapshotFromCheck(state, check));
}

function broadcastUsageChange(snapshot: UsageSnapshot) {
  if (typeof window === "undefined") return;
  usageSeq += 1;
  const stamped = stampUsageSnapshot(snapshot, {
    origin: usageOriginId,
    seq: usageSeq,
    at: Date.now(),
  });
  window.dispatchEvent(new CustomEvent(USAGE_EVENT, { detail: stamped }));
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(USAGE_EVENT, stamped))
    .catch(() => {
      /* not in tauri */
    });
}

/**
 * A snapshot from another window: never re-broadcast, and dropped when it is
 * older than one already applied from that same window.
 */
function applyPeerUsageSnapshot(snapshot: UsageSnapshot) {
  if (isStalePeerSnapshot(peerUsageSeq, snapshot)) return;
  recordPeerSnapshot(peerUsageSeq, snapshot);
  applyUsageSnapshot({ ...snapshot, source: "peer-window" }, { broadcast: false });
}

function applyCachedProfile(token: string, profile: CachedProfile) {
  setState({
    loggedIn: true,
    isLoggingIn: false,
    isLoading: false,
    revalidating: true,
    // Keep the last connectivity flag until fetchAccount succeeds or fails.
    offline: state.loggedIn ? state.offline : false,
    error: null,
    userId: profile.userId,
    email: profile.email,
    name: profile.name,
    tier: profile.tier,
    creditsRemaining: profile.creditsRemaining,
    creditsIncluded: profile.creditsIncluded ?? 0,
    freeAutoPercent: profile.freeAutoPercent,
    currentPeriodEnd: profile.currentPeriodEnd ?? null,
    usageUpdatedAt: profile.cachedAt ?? null,
    accessToken: token,
  });
}

async function saveToken(token: string | null) {
  // Every token change invalidates in-flight account fetches.
  sessionGeneration += 1;
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  broadcastAuthChange();
}

function loadRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function saveRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
}

/** Rotate the access token using the stored refresh token. Returns the new access token. */
export async function refreshShapeAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refresh = loadRefresh();
    if (!refresh) return null;
    try {
      const result = await refreshAccessToken(refresh);
      await saveToken(result.accessToken);
      saveRefresh(result.refreshToken ?? refresh);
      setState({
        accessToken: result.accessToken,
        loggedIn: true,
        error: null,
        offline: false,
      });
      return result.accessToken;
    } catch {
      return null;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function broadcastAuthChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("shape-auth-changed"));
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit("shape-auth-changed"))
    .catch(() => {
      /* not in tauri */
    });
}

function setupAuthSync() {
  if (typeof window === "undefined") return;

  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      void applyToken(e.newValue);
    }
  });

  window.addEventListener("shape-auth-changed", () => {
    void loadToken().then(async (token) => {
      if (token === state.accessToken) return;
      await applyToken(token);
    });
  });

  window.addEventListener(USAGE_EVENT, (e) => {
    const detail = (e as CustomEvent<UsageSnapshot>).detail;
    if (detail) applyPeerUsageSnapshot(detail);
  });

  window.addEventListener("focus", () => {
    revalidateIfStale();
  });

  // WebView focus does not always fire on tab / window switches, so watch
  // visibility too — same staleness guard, so the two together stay cheap.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidateIfStale();
  });

  window.addEventListener("online", () => {
    if (state.accessToken) void refreshShapeAuth();
  });

  if (revalidateTimer === null) {
    revalidateTimer = setInterval(() => {
      if (state.accessToken) refreshShapeUsage();
    }, REVALIDATE_INTERVAL_MS);
  }

  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      Promise.all([
        listen("shape-auth-changed", () => {
          void loadToken().then(async (token) => {
            if (token === state.accessToken) return;
            await applyToken(token);
          });
        }),
        listen<UsageSnapshot>(USAGE_EVENT, (event) => {
          if (event.payload) applyPeerUsageSnapshot(event.payload);
        }),
      ]),
    )
    .catch(() => {
      /* not in tauri */
    });
}

/**
 * Refresh on focus / visibility only when the snapshot has aged out.
 *
 * Usage-changing actions already refresh immediately and broadcast to every
 * window, so a recently confirmed snapshot is genuinely current and refetching
 * it would just burn a request.
 */
function revalidateIfStale() {
  if (!state.accessToken) return;
  if (!isUsageStale(state.usageUpdatedAt, Date.now(), USAGE_STALE_MS)) return;
  refreshShapeUsage();
}

async function applyToken(token: string | null, allowRefresh = true) {
  const generation = sessionGeneration;
  if (!token) {
    // Ending the session invalidates in-flight account fetches. This also covers
    // a sign-out that started in another Shape window: that one bumps its own
    // counter, and this window only finds out through applyToken(null).
    sessionGeneration += 1;
    // The last-turn figure belongs to the session that produced it.
    clearLastTurnUsage();
    clearShapeCatalog();
    saveCachedProfile(null);
    saveRefresh(null);
    setState({
      ...DEFAULT_STATE,
      isLoading: false,
      accessToken: null,
    });
    return;
  }

  const cached = loadCachedProfile();
  const prevTier = state.tier;
  if (cached) {
    applyCachedProfile(token, cached);
  } else {
    setState({
      isLoading: true,
      revalidating: false,
      offline: false,
      accessToken: token,
    });
  }

  try {
    const account = await fetchAccount(token);
    // Signed out, or the token rotated, while this was in flight. Writing now
    // would resurrect a session the user has already left.
    if (generation !== sessionGeneration) return;
    saveCachedProfile({
      userId: account.id,
      email: account.email,
      name: account.name,
      tier: account.tier,
      creditsRemaining: account.creditsRemaining,
      creditsIncluded: account.creditsIncluded,
      freeAutoPercent: account.freeAutoPercent,
      currentPeriodEnd: account.currentPeriodEnd ?? null,
      cachedAt: Date.now(),
    });
    setState({
      loggedIn: true,
      isLoggingIn: false,
      isLoading: false,
      revalidating: false,
      offline: false,
      error: null,
      userId: account.id,
      email: account.email,
      name: account.name,
      tier: account.tier,
      creditsRemaining: account.creditsRemaining,
      creditsIncluded: account.creditsIncluded,
      freeAutoPercent: account.freeAutoPercent,
      currentPeriodEnd: account.currentPeriodEnd ?? null,
      usageUpdatedAt: Date.now(),
      accessToken: token,
    });
    // Other Shape windows hold their own copy of this store — hand them the
    // numbers we just paid for instead of leaving them on the cached profile.
    broadcastUsageChange(usageSnapshotFromAccount(account));
    void identifyTelemetryUser(account.id, { tier: account.tier });
    void Promise.all([import("@/lib/settings"), import("@/lib/telemetry")]).then(
      ([{ getSettings }, { applyTelemetryPreference }]) => {
        applyTelemetryPreference(getSettings().privacy.telemetryEnabled);
      },
    );
    if (account.tier !== prevTier || !cached) {
      void refreshShapeCatalog(token).catch(() => undefined);
      void refreshShapeRuntime({ userId: account.id, tier: account.tier }).catch(() => undefined);
    }
  } catch (err) {
    // The session moved on while the request was in flight — stay out of it.
    if (generation !== sessionGeneration) return;
    const isAuthError =
      err instanceof ShapeApiError && (err.status === 401 || err.status === 404);
    const isNetwork =
      err instanceof ShapeApiError ? err.isNetworkError : true;

    if (isAuthError) {
      if (allowRefresh) {
        const next = await refreshShapeAccessToken();
        if (next && next !== token) {
          await applyToken(next, false);
          return;
        }
      }
      await saveToken(null);
      saveRefresh(null);
      saveCachedProfile(null);
      clearShapeCatalog();
      setState({
        ...DEFAULT_STATE,
        isLoading: false,
        error: "Session expired. Sign in again.",
      });
      return;
    }

    if (cached && isNetwork) {
      // Soft offline: keep cached session, no toast.
      setState({
        loggedIn: true,
        isLoading: false,
        revalidating: false,
        offline: true,
        error: null,
        accessToken: token,
        userId: cached.userId,
        email: cached.email,
        name: cached.name,
        tier: cached.tier,
        creditsRemaining: cached.creditsRemaining,
        creditsIncluded: cached.creditsIncluded ?? 0,
        freeAutoPercent: cached.freeAutoPercent,
      });
      return;
    }

    setState({
      ...DEFAULT_STATE,
      isLoading: false,
      error: err instanceof Error ? err.message : "Could not load account.",
    });
  }
}

async function finishOAuth(code: string) {
  if (finishedOAuthCode === code || finishingOAuth) return;
  if (state.loggedIn) return;
  ensurePendingOAuthLoaded();
  finishingOAuth = true;
  // Stop poll loop so it cannot race a second token exchange.
  clearLoginPoll();

  try {
    const result = await exchangeOAuthCode(code, REDIRECT_URI, pendingCodeVerifier ?? undefined);
    finishedOAuthCode = code;
    await saveToken(result.accessToken);
    saveRefresh(result.refreshToken ?? null);
    pendingState = null;
    pendingCodeVerifier = null;
    clearPendingOAuth();
    await applyToken(result.accessToken);
    settleLoginWaiter(true);
  } catch (err) {
    // Concurrent success already signed us in; treat expired-code races as OK.
    if (state.loggedIn || finishedOAuthCode) {
      settleLoginWaiter(true);
      return;
    }
    pendingState = null;
    pendingCodeVerifier = null;
    clearPendingOAuth();
    const message = err instanceof Error ? err.message : "Sign in failed";
    reportAuthError(message);
    settleLoginWaiter(false);
  } finally {
    finishingOAuth = false;
  }
}

function handleOAuthDeepLink(rawUrl: string) {
  try {
    ensurePendingOAuthLoaded();
    const url = new URL(rawUrl);
    const error = url.searchParams.get("error");
    if (error) {
      clearLoginPoll();
      clearPendingOAuth();
      pendingState = null;
      pendingCodeVerifier = null;
      reportAuthError(
        error === "access_denied" ? "Sign-in was cancelled" : `Sign-in failed (${error})`,
      );
      settleLoginWaiter(false);
      return;
    }

    const code = url.searchParams.get("code");
    const linkState = url.searchParams.get("state");
    if (!code) return;

    if (pendingState && linkState && linkState !== pendingState && code !== pendingState) {
      return;
    }

    void finishOAuth(code);
  } catch (err) {
    console.warn("[shape-auth] invalid oauth callback url:", err);
  }
}

let deepLinkListening = false;

async function setupOAuthDeepLinkListener() {
  if (deepLinkListening || typeof window === "undefined") return;
  deepLinkListening = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("shape-oauth-callback", (event) => {
      handleOAuthDeepLink(event.payload);
    });
  } catch {
    /* browser / non-tauri */
  }
}

function nextPollDelayMs() {
  pollAttempt += 1;
  if (pollAttempt <= 3) return LOGIN_POLL_BASE_MS;
  return Math.min(LOGIN_POLL_MAX_MS, LOGIN_POLL_BASE_MS * 2 ** (pollAttempt - 3));
}

async function pollForOAuthCallback(deadline: number, generation: number) {
  if (generation !== loginPollGeneration) return;

  if (!state.isLoggingIn || !pendingState || Date.now() >= deadline) {
    if (generation !== loginPollGeneration) return;
    if (state.isLoggingIn && pendingState) {
      pendingState = null;
      pendingCodeVerifier = null;
      clearPendingOAuth();
      reportAuthError("Sign-in cancelled or timed out");
      settleLoginWaiter(false);
    }
    return;
  }

  try {
    const result = await pollOAuthCode(pendingState);
    if (generation !== loginPollGeneration) return;
    if (result.ready && result.code) {
      await finishOAuth(result.code);
      return;
    }
  } catch (err) {
    if (generation !== loginPollGeneration) return;
    if (err instanceof ShapeApiError && !err.isNetworkError && err.status >= 400 && err.status !== 404) {
      clearLoginPoll();
      reportAuthError(err.message);
      settleLoginWaiter(false);
      return;
    }
  }

  if (generation !== loginPollGeneration) return;
  loginPollTimer = setTimeout(() => {
    void pollForOAuthCallback(deadline, generation);
  }, nextPollDelayMs());
}

export async function initShapeAuth() {
  if (initialized) return;
  initialized = true;
  setupAuthSync();
  void setupOAuthDeepLinkListener();

  const token = await loadToken();
  if (token) {
    const cached = loadCachedProfile();
    if (cached) applyCachedProfile(token, cached);
    clearPendingOAuth();
  }
  void refreshShapeCatalog(token).catch(() => undefined);
  void refreshShapeRuntime().catch(() => undefined);
  // Through the scheduler so a focus event firing mid-boot cannot overlap it.
  await usageScheduler.flush();

  // Resume PKCE after rebuild/reload while the browser login is still in flight.
  // Must run after applyToken(null), which resets isLoggingIn via DEFAULT_STATE.
  if (!token) {
    ensurePendingOAuthLoaded();
    if (pendingState && pendingCodeVerifier) {
      const saved = loadPendingOAuth();
      const remaining = saved
        ? LOGIN_TIMEOUT_MS - (Date.now() - saved.startedAt)
        : 0;
      if (remaining > 5_000) {
        setState({ isLoggingIn: true, error: null, isLoading: false });
        const deadline = Date.now() + remaining;
        const generation = loginPollGeneration;
        void pollForOAuthCallback(deadline, generation);
      } else {
        clearPendingOAuth();
        pendingState = null;
        pendingCodeVerifier = null;
      }
    }
  }
}

export type LoginShapeOpen =
  | { kind?: "login"; email?: string }
  | { kind: "provider"; provider: "github" | "gitlab" };

export async function loginShape(open?: LoginShapeOpen): Promise<boolean> {
  if (state.loggedIn) return true;
  if (state.isLoggingIn) {
    return new Promise<boolean>((resolve) => {
      const previous = loginWaiter;
      loginWaiter = (success) => {
        previous?.(success);
        resolve(success);
      };
    });
  }

  return new Promise<boolean>((resolve) => {
    loginWaiter = resolve;
    void startLoginShape(open);
  });
}

async function startLoginShape(open?: LoginShapeOpen) {
  clearLoginPoll();
  finishedOAuthCode = null;
  await setupOAuthDeepLinkListener();
  setState({ isLoggingIn: true, error: null });
  pendingState = crypto.randomUUID();
  const pkce = await createPkcePair();
  pendingCodeVerifier = pkce.verifier;
  savePendingOAuth(pendingState, pendingCodeVerifier);
  const authorizeUrl = oauthAuthorizeUrl(pendingState, pkce.challenge);
  const url =
    open?.kind === "provider"
      ? websiteProviderSignInUrl(open.provider, authorizeUrl)
      : websiteLoginUrl({ callbackUrl: authorizeUrl, email: open?.email });
  try {
    await commands.openUrlExternal(url);
  } catch (err) {
    clearPendingOAuth();
    pendingState = null;
    pendingCodeVerifier = null;
    reportAuthError(err instanceof Error ? err.message : "Could not open the browser");
    settleLoginWaiter(false);
    return;
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const generation = loginPollGeneration;
  void pollForOAuthCallback(deadline, generation);
}

/** Stop an in-progress browser sign-in and unblock the UI. */
export function cancelLoginShape() {
  if (!state.isLoggingIn) return;
  clearLoginPoll();
  pendingState = null;
  pendingCodeVerifier = null;
  clearPendingOAuth();
  reportAuthError("Sign-in cancelled");
  settleLoginWaiter(false);
}

export async function logoutShape() {
  clearLoginPoll();
  pendingState = null;
  pendingCodeVerifier = null;
  clearPendingOAuth();
  settleLoginWaiter(false);
  const token = state.accessToken;
  if (token) {
    try {
      await revokeToken(token);
    } catch {
      /* ignore */
    }
  }
  await saveToken(null);
  saveRefresh(null);
  saveCachedProfile(null);
  clearShapeCatalog();
  setState({ ...DEFAULT_STATE, isLoading: false });
}

export function openShapeBilling() {
  void commands.openUrlExternal(dashboardUrl());
}

export function useShapeAuth() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getShapeAccessToken(): string | null {
  return state.accessToken;
}

export function getShapeAuthState(): ShapeAuthState {
  return state;
}

/** The one place that re-reads /api/account for usage; everything routes here. */
async function loadAccountUsage() {
  const token = state.accessToken ?? (await loadToken());
  await applyToken(token);
}

/**
 * Queue a usage refresh. Safe to call after every usage-changing action: the
 * scheduler collapses bursts and serialises the requests.
 */
export function refreshShapeUsage(): void {
  usageScheduler.schedule();
}

/** Refresh now (Settings → Refresh, regaining connectivity). Still serialised. */
export async function refreshShapeAuth() {
  await usageScheduler.flush();
}

/** Call when an API response indicates the session is no longer valid. */
export async function handleAuthFailure() {
  await saveToken(null);
  saveRefresh(null);
  saveCachedProfile(null);
  clearShapeCatalog();
  setState({
    ...DEFAULT_STATE,
    isLoading: false,
    error: "Session expired. Sign in again.",
  });
}
