/**
 * Runs `worker` over `items` with at most `limit` in flight.
 * Raycast runs extensions in a memory-capped worker, so unbounded Promise.all
 * over dozens of multi-megabyte transcripts is not an option.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, run));
  return results;
}
