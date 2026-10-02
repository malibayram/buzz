import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RETRY_MS,
  MAX_ATTEMPTS,
  MAX_RETRY_MS,
  createLinkSupervisor,
} from "./linkSupervisor.ts";

function fakeTimers() {
  const pending = [];
  return {
    pending,
    timers: {
      set: (callback, ms) => {
        const handle = { callback, ms };
        pending.push(handle);
        return handle;
      },
      clear: (handle) => {
        const index = pending.indexOf(handle);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    fire() {
      const next = pending.shift();
      assert.ok(next, "expected a scheduled retry");
      next.callback();
      return next.ms;
    },
  };
}

function link(name) {
  return {
    name,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("reconnects after a drop and reports the new link", async () => {
  const clock = fakeTimers();
  const closers = [];
  const links = [link("a"), link("b")];
  const states = [];
  const sup = createLinkSupervisor({
    open: (onClose) => {
      closers.push(onClose);
      return Promise.resolve(links.shift());
    },
    onChange: (state, current) => states.push([state, current.name ?? null]),
    timers: clock.timers,
  });
  sup.start();
  await settle();
  assert.equal(sup.state(), "open");
  closers[0]();
  assert.equal(sup.state(), "reconnecting");
  assert.equal(clock.fire(), BASE_RETRY_MS);
  await settle();
  assert.equal(sup.state(), "open");
  assert.equal(sup.link().name, "b");
  assert.deepEqual(states.at(-1), ["open", "b"]);
});

test("backs off exponentially, capped, then fails until retried", async () => {
  const clock = fakeTimers();
  let opens = 0;
  const sup = createLinkSupervisor({
    open: () => {
      opens += 1;
      return Promise.reject(new Error("down"));
    },
    onChange: () => undefined,
    timers: clock.timers,
  });
  sup.start();
  const delays = [];
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await settle();
    delays.push(clock.fire());
  }
  await settle();
  assert.equal(sup.state(), "failed");
  assert.equal(clock.pending.length, 0, "a failed supervisor stops retrying");
  assert.equal(opens, MAX_ATTEMPTS + 1);
  assert.equal(delays[0], BASE_RETRY_MS);
  assert.ok(delays.every((ms) => ms <= MAX_RETRY_MS));
  assert.equal(delays.at(-1), MAX_RETRY_MS);

  sup.retry();
  assert.equal(opens, MAX_ATTEMPTS + 2, "retry connects immediately");
});

test("a stale attempt that resolves late is closed, not adopted", async () => {
  const clock = fakeTimers();
  const late = link("late");
  let resolveLate;
  const sup = createLinkSupervisor({
    open: () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
    onChange: () => undefined,
    timers: clock.timers,
  });
  sup.start();
  sup.stop();
  resolveLate(late);
  await settle();
  assert.equal(late.closed, true);
  assert.equal(sup.state(), "idle");
});

test("fail() closes the link and ignores its later close callback", async () => {
  const clock = fakeTimers();
  const only = link("only");
  let onClose;
  const sup = createLinkSupervisor({
    open: (close) => {
      onClose = close;
      return Promise.resolve(only);
    },
    onChange: () => undefined,
    timers: clock.timers,
  });
  sup.start();
  await settle();
  sup.fail();
  onClose();
  assert.equal(only.closed, true);
  assert.equal(sup.state(), "failed");
  assert.equal(clock.pending.length, 0);
});
