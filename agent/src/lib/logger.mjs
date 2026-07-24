// Minimal structured logger. Emits one JSON line per event so the worker's output
// is greppable in any host's log viewer.
//
// Operational logging only: never pass raw email addresses, bodies, tokens, or
// other secrets/PII as fields. Log ids, counts, and statuses.

function emit(level, message, fields = {}) {
  const line = { level, message, ts: new Date().toISOString(), ...fields };
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
