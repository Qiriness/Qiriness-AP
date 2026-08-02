export function createSupabaseClient(config) {
  return {
    baseUrl: `${config.supabaseUrl}/rest/v1`,
    key: config.supabaseKey
  };
}

export async function supabaseUpsert(client, table, rows, onConflict) {
  const normalizedRows = normalizeBulkRows(rows);
  const response = await fetch(
    `${client.baseUrl}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: 'POST',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(normalizedRows)
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase upsert into ${table} failed: ${detail}`);
  }
  return payload;
}

export async function supabaseInsert(client, table, rows) {
  if (rows.length === 0) {
    return [];
  }

  const normalizedRows = normalizeBulkRows(rows);
  const response = await fetch(
    `${client.baseUrl}/${table}`,
    {
      method: 'POST',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(normalizedRows)
    }
  );

  const payload = await response.json().catch(() => null);
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

  const response = await fetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'GET',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`
      }
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
 */
export async function supabaseSelectAll(client, table, filters, select = '*', options = {}) {
  const order = options.order || 'id.asc';
  const max = options.limit ?? Infinity;
  const pageSize = options.pageSize || 1000;
  const rows = [];

  for (let from = 0; rows.length < max; ) {
    const searchParams = new URLSearchParams({ select, order });
    applyFilters(searchParams, filters);

    const response = await fetch(`${client.baseUrl}/${table}?${searchParams.toString()}`, {
      method: 'GET',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Range-Unit': 'items',
        Range: `${from}-${from + pageSize - 1}`
      }
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
      throw new Error(`Supabase select from ${table} failed: ${detail}`);
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }

    rows.push(...payload);
    from += payload.length;
  }

  return rows.length > max ? rows.slice(0, max) : rows;
}

/**
 * Calls a Postgres function through PostgREST's /rpc endpoint.
 *
 * Exists for work SQL can do and a REST filter cannot — vector search being the
 * first case: `<=>` has no PostgREST equivalent, so without this the only way to
 * rank by embedding is to pull every row and its 1536 floats to the client.
 */
export async function supabaseRpc(client, functionName, args = {}) {
  const response = await fetch(`${client.baseUrl}/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: client.key,
      Authorization: `Bearer ${client.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase rpc ${functionName} failed: ${detail}`);
  }
  return payload;
}

export async function supabaseUpdate(client, table, filters, row) {
  const searchParams = new URLSearchParams();
  applyFilters(searchParams, filters);

  const response = await fetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'PATCH',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(row)
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase update ${table} failed: ${detail}`);
  }
  return payload;
}

export async function supabaseUpdateById(client, table, id, row) {
  const searchParams = new URLSearchParams({ id: `eq.${id}` });
  const response = await fetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'PATCH',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(row)
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase update ${table} failed: ${detail}`);
  }
  return payload[0];
}

export async function supabaseDeleteWhereIn(client, table, column, values) {
  if (values.length === 0) {
    return;
  }

  const filter = `in.(${values.join(',')})`;
  const response = await fetch(
    `${client.baseUrl}/${table}?${encodeURIComponent(column)}=${encodeURIComponent(filter)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        Prefer: 'return=minimal'
      }
    }
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase delete from ${table} failed: ${detail}`);
  }
}

export async function supabaseDelete(client, table, filters) {
  const searchParams = new URLSearchParams();
  applyFilters(searchParams, filters);

  const response = await fetch(
    `${client.baseUrl}/${table}?${searchParams.toString()}`,
    {
      method: 'DELETE',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        Prefer: 'return=representation'
      }
    }
  );

  const payload = await response.json().catch(() => null);
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
