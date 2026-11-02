import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { type UserEvent, userEvent } from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { App } from "../src/app.tsx";
import { createAppRouter } from "../src/router.tsx";
import { FakeApi } from "./fake-api.ts";

afterEach(() => vi.unstubAllGlobals());

export type RenderedApp = {
  fake: FakeApi;
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
  user: UserEvent;
  /** What the periodic refresh would do: requests everything active again. */
  refresh: () => Promise<void>;
  unmount: () => void;
};

/** Mounts the full app at `path` against a FakeApi; without periodic refresh or retries. */
export function renderApp(path: string, fake = new FakeApi()): RenderedApp {
  vi.stubGlobal("fetch", fake.fetch);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const user = userEvent.setup();
  const { unmount } = render(<App router={router} queryClient={queryClient} />);
  const refresh = () => queryClient.refetchQueries({ type: "active" });
  return { fake, router, queryClient, user, refresh, unmount };
}

/** Simulates the color scheme the system declares (prefers-color-scheme). */
export function stubColorScheme(scheme: "light" | "dark") {
  const base = globalThis.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => ({
    ...base(query),
    matches: query.includes("prefers-color-scheme: dark") && scheme === "dark",
  }));
}
