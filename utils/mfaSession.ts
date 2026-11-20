/** How long an admin may keep using this browser after the last TOTP check. */
export const MFA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type MfaMethodClaim = { method?: unknown; timestamp?: unknown } | string;

export type MfaAccessDecision =
    | { status: 'allow'; verifiedAtMs: number }
    | { status: 'step-up' }
    | { status: 'reauthenticate' };

const toMillis = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    // Supabase amr timestamps are unix seconds. Values this small are not milliseconds.
    return value < 1e12 ? value * 1000 : value;
};

export const latestTotpVerifiedAtMs = (methods: readonly MfaMethodClaim[] | null | undefined): number | null => {
    if (!methods) return null;
    let latest: number | null = null;
    for (const method of methods) {
        if (typeof method === 'string' || String(method?.method ?? '').toLowerCase() !== 'totp') continue;
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
