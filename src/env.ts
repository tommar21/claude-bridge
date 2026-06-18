/** Parse a numeric environment variable with a validated fallback.
 *
 *  `parseInt` on a typo'd value ("5min", "eight", "") yields NaN, which
 *  silently changes runtime meaning rather than failing loudly:
 *  `setTimeout(fn, NaN)` fires immediately (a NaN timeout becomes 0 → every
 *  request times out instantly) and `inFlight >= NaN` is always false (the
 *  concurrency gate never engages → unbounded concurrency). Route every
 *  numeric env read through here so a bad value falls back to the documented
 *  default with a warning instead.
 */
export function intEnv(
  name: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  // Strict: require a pure integer. `parseInt` is lenient ("5min" → 5,
  // "0x10" → 0), which would silently accept a typo as a wrong-but-finite
  // value. Reject anything that isn't exactly an optionally-signed integer.
  const n = /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(n)) {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "Invalid numeric env var, using default",
        name,
        raw,
        fallback,
      })}\n`,
    );
    return fallback;
  }
  let v = n;
  if (opts?.min !== undefined && v < opts.min) v = opts.min;
  if (opts?.max !== undefined && v > opts.max) v = opts.max;
  return v;
}
