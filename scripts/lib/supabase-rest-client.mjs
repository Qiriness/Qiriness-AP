export function createSupabaseClient(config) {
  return {
    baseUrl: `${config.supabaseUrl}/rest/v1`,
    key: config.supabaseKey
  };
}

export function supabaseHeaders(client, extra = {}) {
  const headers = {
    apikey: client.key,
    ...extra
  };

  // Legacy anon/service_role keys are JWTs and PostgREST expects them as the
  // bearer token. New Supabase publishable/secret keys (`sb_*`) are API Gateway
  // keys, not JWTs; sending `Authorization: Bearer sb_secret_...` makes the
  // request 401 even though the same key is valid in `apikey`.
  if (!client.key.startsWith('sb_')) {
    headers.Authorization = `Bearer ${client.key}`;
  }

  return headers;
}

/**
 * Every request in this module goes through here, so `cache: 'no-store'` cannot
 * be forgotten on a call site added later.
 *
 * IT IS LOAD-BEARING FOR THE DASHBOARD. Next.js patches global fetch inside
 * Server Components and Route Handlers, and left alone it stores these
 * responses in its Data Cache with a one-year revalidate — keyed on the URL, so
 * every request afterwards replays the first body it ever saw. That is not
 * theoretical: the dashboard served an empty forwarding table and articles
 * still marked `draft` for as long as the cache lived, while Supabase held the
 * saved values. `export const dynamic = "force-dynamic"` on the page does NOT
 * prevent it; only an explicit no-store on the fetch does.
 *
 * Outside Next — the sync scripts and the agent worker — the option is inert.
 */
// Transient failures are not exceptional at sync scale. A customers sync is
// ~1,000 sequential requests, and this project has already lost a products sync
// at row 30 to `fetch failed` (an IPv6 timeout to Supabase) and a verification
// query to the same thing. Without a retry a single blip means starting over,
// and there is no resume.
//
// Retried: network errors (no response at all) and 5xx/429, which are the
// server saying "not now". NOT retried: 4xx, which is the server saying the
// request is wrong — repeating it just fails slower.
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function supabaseFetch(url, init, attempt = 1) {
  let response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store' });
  } catch (error) {
    if (attempt >= RETRY_ATTEMPTS) {
      throw new Error(`Supabase request failed after ${attempt} attempts: ${error.message}`);
    }
    // Exponential, so a brief blip costs 400ms and a longer outage backs off.
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return supabaseFetch(url, init, attempt + 1);
  }

  if ((response.status >= 500 || response.status === 429) && attempt < RETRY_ATTEMPTS) {
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return supabaseFetch(url, init, attempt + 1);
  }

  return response;
}

export async function supabaseUpsert(client, table, rows, onConflict, { returning } = {}) {
  const minimal = returning === 'minimal';
  const normalizedRows = normalizeBulkRows(rows);
  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: 'POST',
      headers: supabaseHeaders(client, {
        'Content-Type': 'application/json',
        Prefer: `resolution=merge-duplicates,${minimal ? 'return=minimal' : 'return=representation'}`
      }),
      body: JSON.stringify(normalizedRows)
    }
  );

  const payload = minimal && response.ok ? [] : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase upsert into ${table} failed: ${detail}`);
  }
  return payload;
}

export async function supabaseInsert(client, table, rows, { returning } = {}) {
  if (rows.length === 0) {
    return [];
  }

  const minimal = returning === 'minimal';
  const normalizedRows = normalizeBulkRows(rows);
  const response = await supabaseFetch(
    `${client.baseUrl}/${table}`,
    {
      method: 'POST',
      headers: supabaseHeaders(client, {
        'Content-Type': 'application/json',
        Prefer: minimal ? 'return=minimal' : 'return=representation'
      }),
      body: JSON.stringify(normalizedRows)
    }
  );

  const payload = minimal && response.ok ? [] : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase insert into ${table} failed: ${detail}`);
  }
  return payload;
}

// options: { order: 'column.asc' | 'column.desc', limit: number } — PostgREST
// query modifiers for batch readers that need a deterministic slice rather than
// the whole table.
export async function supabaseSelect(client, table, filters, select = '*', options = {}) {
  const searchParams = new URLSearchParams({ select });
  applyFilters(searchParams, filters);
  if (options.order) {
    searchParams.set('order', options.order);
  }
  if (options.limit) {
    searchParams.set('limit', String(options.limit));
  }

  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'GET',
      headers: supabaseHeaders(client)
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase select from ${table} failed: ${detail}`);
  }
  return payload;
}

/**
 * Every row matching the filters, paged — for readers that must see the whole
 * table rather than a slice.
 *
 * WHY THIS EXISTS. PostgREST caps a single response at the server's
 * `db-max-rows` (1000 on Supabase) and does it SILENTLY: `limit=5000` comes back
 * as 1000 rows with a 206 and no error, so a caller that simply passed a large
 * limit has been reading a truncated table without knowing. That is exactly what
 * the clustering report was doing — 1111 embedded messages, 1000 read.
 *
 * Advances by the number of rows actually returned and stops on an empty page,
 * rather than assuming the server honours the requested page size. That way the
 * paging stays correct whatever `db-max-rows` is set to, now or later.
 *
 * A stable sort is required, not optional: without an ORDER BY, Postgres may
 * return rows in a different order per request, which makes offset paging drop
 * some rows and repeat others. Defaults to `id.asc`.
 *
 * KEYSET, NOT OFFSET, ON THE DEFAULT ORDER. Each page asks for `id > last id
 * seen` instead of skipping `from` rows. An offset makes Postgres read and
 * discard every earlier row, so a full pass costs O(n²): paging 61k customers
 * this way was 71% of all buffer reads in production (501M blocks, 1,699 s of
 * database time, 2026-08-07 → 10-12). Keyset is O(n) through the primary key,
 * and cannot skip or repeat a row when the table changes mid-read. A caller
 * that sorts on anything else, or filters on `id` itself, keeps offset paging.
 * When the select leaves `id` out, it is fetched for the cursor and removed, so
 * every caller gets back exactly the columns it asked for.
 */
export async function supabaseSelectAll(client, table, filters, select = '*', options = {}) {
  const order = options.order || 'id.asc';
  const max = options.limit ?? Infinity;
  // Never ask for more than the caller will keep: a limit of 500 used to fetch
  // a full 1000-row page and throw half of it away.
  const pageSize = Math.min(options.pageSize || 1000, max);
  const keyset = order === 'id.asc' && !Object.hasOwn(filters || {}, 'id');
  const selectsId = topLevelColumns(select).some((column) => column === 'id' || column === '*');
  const requested = keyset && !selectsId ? `${select},id` : select;
  const rows = [];
  let lastId = null;

  for (let from = 0; rows.length < max; ) {
    const searchParams = new URLSearchParams({ select: requested, order });
    applyFilters(searchParams, filters);
    if (keyset && lastId !== null) {
      searchParams.set('id', `gt.${lastId}`);
    }

    const response = await supabaseFetch(`${client.baseUrl}/${table}?${searchParams.toString()}`, {
      method: 'GET',
      headers: supabaseHeaders(client, {
        'Range-Unit': 'items',
        Range: keyset ? `0-${pageSize - 1}` : `${from}-${from + pageSize - 1}`
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
      throw new Error(`Supabase select from ${table} failed: ${detail}`);
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }

    if (keyset) {
      lastId = payload[payload.length - 1].id;
      if (lastId === undefined || lastId === null) {
        throw new Error(`Supabase select from ${table}: keyset paging needs an id on every row`);
      }
    }
    rows.push(...(keyset && !selectsId ? payload.map(({ id, ...rest }) => rest) : payload));
    from += payload.length;
  }

  return rows.length > max ? rows.slice(0, max) : rows;
}

/** The top-level column list of a PostgREST `select`, ignoring embedded resources' inner lists. */
function topLevelColumns(select) {
  const columns = [];
  let depth = 0;
  let current = '';
  for (const char of String(select)) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      columns.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  columns.push(current.trim());
  return columns;
}

/**
 * Calls a Postgres function through PostgREST's /rpc endpoint.
 *
 * Exists for work SQL can do and a REST filter cannot — vector search being the
 * first case: `<=>` has no PostgREST equivalent, so without this the only way to
 * rank by embedding is to pull every row and its 1536 floats to the client.
 */
export async function supabaseRpc(client, functionName, args = {}) {
  const response = await supabaseFetch(`${client.baseUrl}/rpc/${functionName}`, {
    method: 'POST',
    headers: supabaseHeaders(client, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(args)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase rpc ${functionName} failed: ${detail}`);
  }
  return payload;
}

// `select` shapes the returned representation, exactly as it does on a read —
// including embedded resources. Without it PostgREST returns the patched row's
// own columns only, so a caller that reads a ticket WITH its customer and then
// updates it gets back a narrower object than it started with.
export async function supabaseUpdate(client, table, filters, row, { select, returning } = {}) {
  const minimal = returning === 'minimal';
  const searchParams = new URLSearchParams();
  applyFilters(searchParams, filters);
  if (select) {
    searchParams.set('select', select);
  }

  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(client, {
        'Content-Type': 'application/json',
        Prefer: minimal ? 'return=minimal' : 'return=representation'
      }),
      body: JSON.stringify(row)
    }
  );

  const payload = minimal && response.ok ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase update ${table} failed: ${detail}`);
  }
  return payload;
}

// `returning: 'minimal'` asks PostgREST for no body at all. Without it every
// PATCH downloads the whole row back, which on `tickets` (metadata, context,
// overrides) is kilobytes per write that most callers never read.
export async function supabaseUpdateById(client, table, id, row, { returning } = {}) {
  const searchParams = new URLSearchParams({ id: `eq.${id}` });
  const minimal = returning === 'minimal';
  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(client, {
        'Content-Type': 'application/json',
        Prefer: minimal ? 'return=minimal' : 'return=representation'
      }),
      body: JSON.stringify(row)
    }
  );

  const payload = minimal && response.ok ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase update ${table} failed: ${detail}`);
  }
  return minimal ? undefined : payload[0];
}

export async function supabaseDeleteWhereIn(client, table, column, values) {
  if (values.length === 0) {
    return;
  }

  const filter = `in.(${values.join(',')})`;
  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?${encodeURIComponent(column)}=${encodeURIComponent(filter)}`,
    {
      method: 'DELETE',
      headers: supabaseHeaders(client, {
        Prefer: 'return=minimal'
      })
    }
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase delete from ${table} failed: ${detail}`);
  }
}

export async function supabaseDelete(client, table, filters, { returning } = {}) {
  const minimal = returning === 'minimal';
  const searchParams = new URLSearchParams();
  applyFilters(searchParams, filters);

  const response = await supabaseFetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'DELETE',
      headers: supabaseHeaders(client, {
        Prefer: minimal ? 'return=minimal' : 'return=representation'
      })
    }
  );

  const payload = minimal && response.ok ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase delete from ${table} failed: ${detail}`);
  }
  return payload || [];
}

function applyFilters(searchParams, filters) {
  for (const [column, value] of Object.entries(filters)) {
    if (value && typeof value === 'object' && value.operator && Object.hasOwn(value, 'value')) {
      searchParams.set(column, `${value.operator}.${value.value}`);
    } else {
      searchParams.set(column, `eq.${value}`);
    }
  }
}

function normalizeBulkRows(rows) {
  if (rows.length < 2) {
    return rows;
  }

  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return rows.map((row) => Object.fromEntries(
    keys.map((key) => [
      key,
      Object.hasOwn(row, key) ? row[key] : null
    ])
  ));
}
