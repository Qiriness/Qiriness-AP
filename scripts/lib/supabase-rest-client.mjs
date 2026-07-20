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

export async function supabaseSelect(client, table, filters, select = '*') {
  const searchParams = new URLSearchParams({ select });
  applyFilters(searchParams, filters);

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
