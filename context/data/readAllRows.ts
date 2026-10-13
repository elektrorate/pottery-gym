/**
 * Exact counts are retained for consistency-sensitive domains. Large read-only
 * snapshots can opt out: those pages advance by the returned rows until an
 * empty page, avoiding COUNT(*) without assuming the server's row limit.
 */
export const readAllRows = async (
    queryFactory: (offset: number, limit: number) => PromiseLike<{ data: any[] | null; error: any; count?: number | null }>,
    pageSize = 500,
    options: { requireExactCount?: boolean } = {}
): Promise<{ data: any[]; error: any }> => {
    const data: any[] = [];
    const requireExactCount = options.requireExactCount !== false;
    let expectedCount: number | undefined;
    try {
        const maxPageSize = requireExactCount ? 500 : 1000;
        if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > maxPageSize) {
            throw Object.assign(new Error(`Pagination page size must be an integer between 1 and ${maxPageSize}.`), { code: 'DATA_PAGINATION_ERROR' });
        }
        while (true) {
            const limit = expectedCount === undefined ? pageSize : Math.min(pageSize, expectedCount - data.length);
            const page = await queryFactory(data.length, limit);
            if (page?.error) return { data: [], error: page.error };
            if (!Array.isArray(page?.data)) {
                throw Object.assign(new Error('Pagination response must contain an array of rows.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            if (page.data.length > limit) {
                throw Object.assign(new Error('Pagination returned more rows than the requested range.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            if (requireExactCount) {
                const count = page.count;
                if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
                    throw Object.assign(new Error('Pagination requires a safe nonnegative exact count on every page.'), { code: 'DATA_PAGINATION_ERROR' });
                }
                if (expectedCount !== undefined && count !== expectedCount) {
                    throw Object.assign(new Error('Pagination count changed between pages. Reload the data.'), { code: 'DATA_PAGINATION_ERROR' });
                }
                expectedCount = count;
                if (page.data.length > count - data.length) {
                    throw Object.assign(new Error('Pagination returned more rows than the exact count.'), { code: 'DATA_PAGINATION_ERROR' });
                }
                if (page.data.length === 0 && data.length < count) {
                    throw Object.assign(new Error('Pagination stopped advancing before the exact count was reached.'), { code: 'DATA_PAGINATION_ERROR' });
                }
            }
            data.push(...page.data);
            if (requireExactCount) {
                if (data.length === expectedCount) return { data, error: null };
            } else if (page.data.length === 0) {
                return { data, error: null };
            }
        }
    } catch (error) {
        return { data: [], error: error || Object.assign(new Error('Pagination query failed without an error.'), { code: 'DATA_PAGINATION_ERROR' }) };
    }
};
