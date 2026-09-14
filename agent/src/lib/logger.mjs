// Minimal structured logger. Emits one JSON line per event so the worker's output
// is greppable in any host's log viewer.
//
// Operational logging only: never pass raw email addresses, bodies, tokens, or
// other secrets/PII as fields. Log ids, counts, and statuses.

function emit(level, message, fields = {}) {
  // The three reserved keys are stripped from the caller's fields rather than
  // spread over: a payload field named `level` (a ticket's handling level, say)
  // would otherwise overwrite the log SEVERITY, which is what a log viewer
  // filters on — and it fails silently, producing {"level":2} lines that no
  // longer match a severity filter. Reserved keys win; callers rename.
  //
  // EXCEPT `message`, which is kept as `detail`. Every catch block in the worker
  // logs `{ message: error.message }`, and stripping it silently discarded the
  // one field saying what went wrong — found 2026-09-14 when
  // `ingest.known_message_lookup_failed` fired with no reason attached.
  const { level: _level, message: detail, ts: _ts, ...safe } = fields;
  const line = {
    level,
    message,
    ts: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
    ...safe
  };
  const text = JSON.stringify(line);
  if (level === 'error') {
    process.stderr.write(text + '\n');
  } else {
    process.stdout.write(text + '\n');
  }
}

export const logger = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields)
};
