const PAGE_SIZE = 1000;
const MAX_ROWS = 100000;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Supabase caps each response at 1000 rows. Fetch every row by requesting
 * consecutive ranges. The query must be ordered so pages do not overlap.
 */
export async function fetchAllRows<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}
