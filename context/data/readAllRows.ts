/**
 * The factory must request an exact count, use a stable unique ordering, and
 * apply its timeout to each page. Row identity validation belongs to the caller.
 */
export const readAllRows = async (
    queryFactory: (offset: number, limit: number) => PromiseLike<{ data: any[] | null; error: any; count?: number | null }>,
    pageSize = 500
): Promise<{ data: any[]; error: any }> => {
    const data: any[] = [];
    let expectedCount: number | undefined;
    try {
        if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 500) {
            throw Object.assign(new Error('Pagination page size must be an integer between 1 and 500.'), { code: 'DATA_PAGINATION_ERROR' });
        }
        while (true) {
            const limit = expectedCount === undefined ? pageSize : Math.min(pageSize, expectedCount - data.length);
            const page = await queryFactory(data.length, limit);
            if (page?.error) return { data: [], error: page.error };
            if (!Array.isArray(page?.data)) {
                throw Object.assign(new Error('Pagination response must contain an array of rows.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            const count = page.count;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
                throw Object.assign(new Error('Pagination requires a safe nonnegative exact count on every page.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            if (expectedCount !== undefined && count !== expectedCount) {
                throw Object.assign(new Error('Pagination count changed between pages. Reload the data.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            expectedCount = count;
            if (page.data.length > limit || page.data.length > count - data.length) {
                throw Object.assign(new Error('Pagination returned more rows than the requested range or exact count.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            if (page.data.length === 0 && data.length < count) {
                throw Object.assign(new Error('Pagination stopped advancing before the exact count was reached.'), { code: 'DATA_PAGINATION_ERROR' });
            }
            // A server cap can be smaller than the requested page size.
            data.push(...page.data);
            if (data.length === count) return { data, error: null };
        }
    } catch (error) {
        return { data: [], error: error || Object.assign(new Error('Pagination query failed without an error.'), { code: 'DATA_PAGINATION_ERROR' }) };
    }
};
