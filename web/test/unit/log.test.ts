/**
 * lib/log.ts — structured logger + non-reversible case correlation.
 *
 * Guards two things the rest of the app relies on: (1) every log() call emits
 * exactly one parseable JSON line carrying { ts, level, event }, routed to the
 * console sink by level; and (2) hashCaseId() is deterministic, 'c_'-prefixed,
 * and never echoes the raw case_id (the "No PII in logs" invariant).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashCaseId, log } from "@/lib/log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log", () => {
  it("emits one parseable JSON line with ts, level, and event", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log({ level: "info", event: "test.event", extra: 42 });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("test.event");
    expect(parsed.extra).toBe(42);
    expect(typeof parsed.ts).toBe("string");
    // ts is a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it("routes by level: error -> console.error, warn -> console.warn", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    log({ level: "error", event: "e" });
    log({ level: "warn", event: "w" });
    log({ level: "debug", event: "d" });

    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // debug falls through to console.log.
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("never throws on an unserializable (circular) field", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => log({ level: "info", event: "circ", circular })).not.toThrow();
    // Falls back to the minimal error sink that still names the event.
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[1]).toEqual({ event: "circ" });
  });
});

describe("hashCaseId", () => {
  const RAW = "case_0123456789abcdefghjkmnpqrs";

  it("is deterministic for the same input", () => {
    expect(hashCaseId(RAW)).toBe(hashCaseId(RAW));
  });

  it("is 'c_'-prefixed", () => {
    expect(hashCaseId(RAW).startsWith("c_")).toBe(true);
  });

  it("does not contain the raw case_id as a substring", () => {
    expect(hashCaseId(RAW).includes(RAW)).toBe(false);
  });

  it("differs for different inputs", () => {
    expect(hashCaseId("case_a")).not.toBe(hashCaseId("case_b"));
  });
});
