// Test-only replacement for network and toast boundaries. Production mapping,
// timeout handling and operations are bundled from their real modules.
const harness = () => (globalThis as any).__giftCardHarness;
export const supabase = {
    from: (...args: any[]) => harness().from(...args),
    rpc: (...args: any[]) => harness().rpc(...args)
};
export const showError = (message: string) => harness().errors.push(message);
export const showWarning = (message: string) => harness().warnings.push(message);
