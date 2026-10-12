/**
 * For tests: one page of `rows` exactly as PostgREST would serve it to
 * `supabaseSelectAll` — sorted by id when `order=id.asc`, after the `id=gt.`
 * cursor when there is one, then the `Range` window, capped at 1000.
 *
 * Fakes that ignore the cursor return the first page forever, and the paging
 * loop never ends; that is why every fake that serves a paged read goes
 * through here rather than slicing by `Range` alone.
 */
export function postgrestPage(url, init, rows, { maxRows = 1000 } = {}) {
  const params = new URL(String(url)).searchParams;
  // Every real row has a primary key; a fixture that left it out gets a stable
  // one in fixture order, so the keyset cursor has something to advance on.
  let pool = rows.map((row, i) => (row.id === undefined ? { ...row, id: `fixture-${String(i).padStart(6, '0')}` } : row));
  if (params.get('order') === 'id.asc') {
    pool.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  }
  const cursor = params.get('id');
  if (cursor?.startsWith('gt.')) {
    const after = cursor.slice(3);
    pool = pool.filter((row) => String(row.id) > after);
  }
  const [from, to] = String(init?.headers?.Range ?? `0-${maxRows - 1}`).split('-').map(Number);
  return pool.slice(from, Math.min(to, from + maxRows - 1) + 1);
}
