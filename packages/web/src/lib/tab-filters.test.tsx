import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TAB_FILTERS_KEY, TabFiltersProvider, useTabFilters } from "./tab-filters.tsx";

function wrapper({ children }: { children: ReactNode }) {
  return <TabFiltersProvider>{children}</TabFiltersProvider>;
}

function useAllTabs() {
  const [queue, setQueue] = useTabFilters("queue");
  const [inProgress, setInProgress] = useTabFilters("inProgress");
  const [completed, setCompleted] = useTabFilters("completed");
  return { queue, setQueue, inProgress, setInProgress, completed, setCompleted };
}

describe("tab filter store", () => {
  it("starts every filter of every tab on All", () => {
    const { result } = renderHook(useAllTabs, { wrapper });

    expect(result.current.queue).toEqual({ projectId: "" });
    expect(result.current.inProgress).toEqual({ projectId: "" });
    expect(result.current.completed).toEqual({ projectId: "", prFilter: "" });
  });

  it("keeps a tab's filters independent from the other tabs", () => {
    const { result } = renderHook(useAllTabs, { wrapper });

    act(() => result.current.setQueue({ projectId: "p1" }));
    act(() => result.current.setCompleted({ prFilter: "merged" }));

    expect(result.current.queue).toEqual({ projectId: "p1" });
    expect(result.current.inProgress).toEqual({ projectId: "" });
    expect(result.current.completed).toEqual({ projectId: "", prFilter: "merged" });
  });

  it("restores the filters another instance chose, as after a reload", () => {
    const first = renderHook(useAllTabs, { wrapper });
    act(() => first.result.current.setQueue({ projectId: "p1" }));
    act(() => first.result.current.setCompleted({ projectId: "p1", prFilter: "merged" }));
    expect(first.result.current.queue).toEqual({ projectId: "p1" });
    expect(first.result.current.completed).toEqual({ projectId: "p1", prFilter: "merged" });
    first.unmount();

    const second = renderHook(useAllTabs, { wrapper });

    expect(second.result.current.queue).toEqual({ projectId: "p1" });
    expect(second.result.current.completed).toEqual({ projectId: "p1", prFilter: "merged" });
  });

  it("starts on All when the saved filters are missing or malformed", () => {
    localStorage.setItem(TAB_FILTERS_KEY, "{not json");
    const broken = renderHook(useAllTabs, { wrapper });
    expect(broken.result.current.queue).toEqual({ projectId: "" });
    broken.unmount();

    localStorage.setItem(
      TAB_FILTERS_KEY,
      JSON.stringify({ queue: { projectId: 7 }, completed: null }),
    );
    const wrong = renderHook(useAllTabs, { wrapper });
    expect(wrong.result.current.queue).toEqual({ projectId: "" });
    expect(wrong.result.current.completed).toEqual({ projectId: "", prFilter: "" });
  });

  it("refuses to be used outside the provider", () => {
    expect(() => renderHook(() => useTabFilters("queue"))).toThrow(/TabFiltersProvider/);
  });
});
