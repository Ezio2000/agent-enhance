/**
 * Append context to an error without assuming its `message` is writable.
 *
 * DOMException-style errors (aborted requests, timeouts) expose `message` as a
 * prototype getter, so assigning to it throws a TypeError in strict mode and
 * replaces the real failure with a confusing one.
 */
export function annotateError(error: unknown, suffix: string): unknown {
  if (!(error instanceof Error)) return error;
  try {
    error.message += suffix;
    return error;
  } catch {
    const wrapped = new Error(`${error.message}${suffix}`, { cause: error });
    wrapped.name = error.name;
    const source = error as unknown as Record<string, unknown>;
    const target = wrapped as unknown as Record<string, unknown>;
    for (const key of ["code", "status", "statusCode", "retryable", "requestId"])
      if (source[key] !== undefined) target[key] = source[key];
    return wrapped;
  }
}
