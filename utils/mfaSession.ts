/** How long an admin may keep using this browser after the last TOTP check. */
export const MFA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TOTP_METHODS = new Set(['totp', 'otp']);

export type MfaMethodClaim = { method?: unknown; timestamp?: unknown } | string;

export type MfaAccessDecision =
    | { status: 'allow'; verifiedAtMs: number }
    | { status: 'step-up' }
    | { status: 'reauthenticate' };

const toMillis = (value: unknown): number | null => {
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return toMillis(numeric);
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    // Supabase amr timestamps are unix seconds. Milliseconds and microseconds also appear.
    if (value < 1e11) return value * 1000;
    if (value < 1e14) return value;
    return Math.round(value / 1000);
};

const methodName = (method: MfaMethodClaim) =>
    (typeof method === 'string' ? method : String(method?.method ?? '')).toLowerCase();

export const latestTotpVerifiedAtMs = (methods: readonly MfaMethodClaim[] | null | undefined): number | null => {
    if (!methods) return null;
    let latest: number | null = null;
    for (const method of methods) {
        if (!TOTP_METHODS.has(methodName(method)) || typeof method === 'string') continue;
        const verifiedAtMs = toMillis(method?.timestamp);
        if (verifiedAtMs == null) continue;
        if (latest == null || verifiedAtMs > latest) latest = verifiedAtMs;
    }
    return latest;
};

/**
 * Admin screens stay closed unless the current session is aal2 and its TOTP
 * amr timestamp is inside the 30-day window. A writable timestamp elsewhere
 * cannot satisfy this: aal1 is always step-up, and a missing or stale TOTP
 * claim requires password and code again.
 */
export const assessMfaAccess = (
    currentLevel: string | null | undefined,
    methods: readonly MfaMethodClaim[] | null | undefined,
    nowMs = Date.now()
): MfaAccessDecision => {
    if (currentLevel !== 'aal2') return { status: 'step-up' };
    const verifiedAtMs = latestTotpVerifiedAtMs(methods);
    if (verifiedAtMs == null) return { status: 'reauthenticate' };
    if (verifiedAtMs - nowMs > CLOCK_SKEW_MS) return { status: 'reauthenticate' };
    if (nowMs - verifiedAtMs >= MFA_MAX_AGE_MS) return { status: 'reauthenticate' };
    return { status: 'allow', verifiedAtMs };
};

const trustIsFresh = (verifiedAtMs: number, nowMs: number) =>
    verifiedAtMs - nowMs <= CLOCK_SKEW_MS && nowMs - verifiedAtMs < MFA_MAX_AGE_MS;

/**
 * A hard reload re-reads the access token. Supabase may return `amr` as
 * RFC-8176 strings (`otp`) with no timestamp. That is not a 30-day expiry:
 * a same-user device cookie can supply the time, and a missing timestamp
 * must not be treated as an expired claim. A real stale or future timestamp
 * still requires password and code.
 */
export const resolveMfaAccess = (
    currentLevel: string | null | undefined,
    methods: readonly MfaMethodClaim[] | null | undefined,
    trustVerifiedAtMs: number | null,
    nowMs = Date.now()
): MfaAccessDecision => {
    const decision = assessMfaAccess(currentLevel, methods, nowMs);
    if (decision.status !== 'reauthenticate') return decision;
    if (latestTotpVerifiedAtMs(methods) != null) return decision;
    if (currentLevel === 'aal2' && trustVerifiedAtMs != null && trustIsFresh(trustVerifiedAtMs, nowMs)) {
        return { status: 'allow', verifiedAtMs: trustVerifiedAtMs };
    }
    return { status: 'step-up' };
};
