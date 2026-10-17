import { expect, test } from "bun:test";
import { startPolling } from "../src/client/polling.ts";

test("slow polls never overlap, and stopping in flight prevents another request", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let aborted = false;
  const stop = startPolling(async signal => {
    calls++;
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await gate.promise;
  }, 5);
  try {
    await Bun.sleep(25);
    expect(calls).toBe(1);
    stop();
    expect(aborted).toBe(true);
    gate.resolve();
    await Bun.sleep(25);
    expect(calls).toBe(1);
  } finally { stop(); gate.resolve(); }
});

test("stopping between polls clears the pending timer", async () => {
  let calls = 0;
  const stop = startPolling(async () => { calls++; }, 20);
  await Bun.sleep(1);
  stop();
  await Bun.sleep(40);
  expect(calls).toBe(1);
});
