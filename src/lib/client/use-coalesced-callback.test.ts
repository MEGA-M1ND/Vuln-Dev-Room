import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useCoalescedCallback } from "@/lib/client/use-coalesced-callback";

describe("useCoalescedCallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invokes immediately on the leading edge", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCoalescedCallback(fn, 400));
    act(() => result.current());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one leading and one trailing call", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCoalescedCallback(fn, 400));

    // A run emitting 10 events in quick succession must not cause 10 refetches.
    act(() => {
      for (let i = 0; i < 10; i++) result.current();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(400));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("allows a new leading call once the window has passed", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCoalescedCallback(fn, 400));

    act(() => result.current());
    act(() => void vi.advanceTimersByTime(500));
    act(() => result.current());

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not fire a trailing call after unmount", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCoalescedCallback(fn, 400),
    );
    act(() => {
      result.current();
      result.current(); // schedules the trailing call
    });
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();
    act(() => void vi.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
