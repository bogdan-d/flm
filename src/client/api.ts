import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { startPolling } from "./polling.ts";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The page owns all requests, including mutations launched by event handlers.
export function useApi() {
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const controller = lifetime.current;
    if (!controller) throw new Error("Page is not mounted.");
    const signals = [controller.signal, AbortSignal.timeout(25_000)];
    if (options?.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const response = await fetch(path, { ...options, signal });
    const body = await response.json();
    signal.throwIfAborted();
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
    return body;
  }, []);
}

// Recursive scheduling avoids overlapping polls even when a response is slow.
export function usePolling(poll: (signal: AbortSignal) => Promise<void>) {
  const tick = useEffectEvent(poll);
  useEffect(() => {
    return startPolling(async signal => {
      if (!document.hidden) await tick(signal);
    });
  }, []);
}

export function post(body?: object): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) };
}
