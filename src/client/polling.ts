// Wait for completion before scheduling again, and let the caller abort in-flight work.
export function startPolling(poll: (signal: AbortSignal) => Promise<void>, interval = 1000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  async function run() {
    try { await poll(controller.signal); }
    finally { if (!controller.signal.aborted) timer = setTimeout(run, interval); }
  }
  void run();
  return () => { controller.abort(); clearTimeout(timer); };
}
