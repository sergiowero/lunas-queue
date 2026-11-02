// Filter store: each tab's filters live above the router, so they survive the page unmounting when
// the user navigates to another route and back. In memory only: reloading resets them to All.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type TabFilters = {
  queue: { projectId: string };
  inProgress: { projectId: string };
  completed: { projectId: string; prFilter: string };
};

export type TabName = keyof TabFilters;

const ALL: TabFilters = {
  queue: { projectId: "" },
  inProgress: { projectId: "" },
  completed: { projectId: "", prFilter: "" },
};

type Store = {
  filters: TabFilters;
  update: <T extends TabName>(tab: T, patch: Partial<TabFilters[T]>) => void;
};

const TabFiltersContext = createContext<Store | null>(null);

export function TabFiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<TabFilters>(ALL);
  const update = useCallback<Store["update"]>((tab, patch) => {
    setFilters((current) => ({ ...current, [tab]: { ...current[tab], ...patch } }));
  }, []);
  const store = useMemo(() => ({ filters, update }), [filters, update]);
  return <TabFiltersContext.Provider value={store}>{children}</TabFiltersContext.Provider>;
}

/** The tab's current filters and a setter that merges a patch; independent from the other tabs. */
export function useTabFilters<T extends TabName>(
  tab: T,
): [TabFilters[T], (patch: Partial<TabFilters[T]>) => void] {
  const store = useContext(TabFiltersContext);
  if (!store) throw new Error("useTabFilters needs a TabFiltersProvider");
  const { filters, update } = store;
  const set = useCallback((patch: Partial<TabFilters[T]>) => update(tab, patch), [update, tab]);
  return [filters[tab], set];
}

/**
 * The stored project if it is still in the project list, otherwise All (""). While the list has
 * not loaded the stored value is kept, so the right query is requested from the start.
 */
export function validProjectId(stored: string, projects: { id: string }[] | undefined): string {
  if (stored === "" || !projects) return stored;
  return projects.some((p) => p.id === stored) ? stored : "";
}
