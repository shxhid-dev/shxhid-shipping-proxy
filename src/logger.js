// Tiny dependency-free structured logger.
//
// - LOG_LEVEL (error|warn|info|debug, default info) controls verbosity.
// - LOG_JSON=true emits one JSON object per line for log aggregators;
//   otherwise a human-readable "TS LEVEL msg key=val" line for Railway.
// Errors/warnings go to stderr, everything else to stdout.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const JSON_LOGS = String(process.env.LOG_JSON).toLowerCase() === 'true';

function formatValue(v) {
  if (typeof v === 'string' && (v.includes(' ') || v === '')) return JSON.stringify(v);
  return v;
}

function emit(level, msg, meta) {
  if (LEVELS[level] > LEVEL) return;
  const ts = new Date().toISOString();
  const stream = LEVELS[level] <= LEVELS.warn ? process.stderr : process.stdout;

  if (JSON_LOGS) {
    stream.write(JSON.stringify({ ts, level, msg, ...(meta || {}) }) + '\n');
    return;
  }

  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      line += ` ${k}=${formatValue(v)}`;
    }
  }
  stream.write(line + '\n');
}

export const logger = {
  error: (msg, meta) => emit('error', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};
