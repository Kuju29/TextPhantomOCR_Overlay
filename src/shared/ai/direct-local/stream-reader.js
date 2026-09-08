export async function* decodedLines(
  body,
  { signal = null, deadline = null } = {},
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted)
        throw signal.reason || new DOMException("aborted", "AbortError");
      let timer = null;
      let abortHandler = null;
      const pending = [reader.read()];
      if (signal?.addEventListener)
        pending.push(
          new Promise((_, reject) => {
            abortHandler = () =>
              reject(
                signal.reason || new DOMException("aborted", "AbortError"),
              );
            signal.addEventListener("abort", abortHandler, { once: true });
          }),
        );
      const deadlineValue =
        typeof deadline === "function" ? deadline() : deadline;
      if (deadlineValue != null)
        pending.push(
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ deadlineReached: true }),
              Math.max(0, deadlineValue - performance.now()),
            );
          }),
        );
      let result;
      try {
        result = await Promise.race(pending);
      } finally {
        if (timer != null) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener?.("abort", abortHandler);
      }
      if (result?.deadlineReached) {
        yield {
          deadlineReached: true,
          cancel: (reason) => reader.cancel(reason),
        };
        return;
      }
      if (result.done) break;
      const rawChunk = decoder.decode(result.value, { stream: true });
      buffer += rawChunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      yield { lines, rawChunk, cancel: (reason) => reader.cancel(reason) };
    }
    const rawChunk = decoder.decode();
    buffer += rawChunk;
    if (buffer)
      yield { lines: [buffer], rawChunk, cancel: (reason) => reader.cancel(reason) };
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
}
