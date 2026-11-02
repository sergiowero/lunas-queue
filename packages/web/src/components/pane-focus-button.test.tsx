import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { PaneFocusButton } from "./pane-focus-button.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup(overrides: { herdrPane?: string | null; herdrName?: string | null } = {}) {
  const fake = new FakeApi();
  const task = fake.addTask(fake.addProject().id);
  const run = fake.startRun(task.id, "implement");
  Object.assign(run, overrides);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const view = (
    <QueryClientProvider client={queryClient}>
      <PaneFocusButton run={run} />
    </QueryClientProvider>
  );
  return {
    fake,
    run,
    queryClient,
    user: userEvent.setup(),
    ...render(view),
    stub: (f = fake.fetch) => vi.stubGlobal("fetch", f),
  };
}

describe("PaneFocusButton", () => {
  it("is a button with an accessible name that focuses the pane in herdr and includes the pane id", () => {
    const { run } = setup();
    const button = screen.getByRole("button", { name: `Enfocar pane ${run.herdrPane} en herdr` });
    expect(button.textContent).toBe(run.herdrPane);
  });

  it("on click it asks for the Run's focus and focuses its agent", async () => {
    const { fake, run, user, stub } = setup();
    stub();
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(fake.focused).toEqual([run.herdrName]));
    expect(fake.requests.at(-1)?.path).toBe(`/api/runs/${run.id}/focus`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Enter with focus on the button activates it", async () => {
    const { fake, run, user, stub } = setup();
    stub();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.focused).toEqual([run.herdrName]));
  });

  it("it is disabled while the request is in progress", async () => {
    const { fake, user, stub } = setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub(async (input, init) => {
      await gate;
      return fake.fetch(input, init);
    });
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true));
    release();
    await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
  });

  it.each([
    [409, "agent_gone", "El agente ya no está en herdr."],
    [502, "herdr_error", "herdr no responde"],
    [503, "focus_unavailable", "No se puede enfocar en herdr desde este servidor."],
  ])(
    "si el foco responde %i %s muestra el error junto al pane y el botón sigue",
    async (status, error, message) => {
      const { fake, user, stub } = setup();
      fake.focusError = { status, error, message };
      stub();
      await user.click(screen.getByRole("button"));
      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
    },
  );

  it("if the row moves to another Run it does not inherit the previous Run's focus error", async () => {
    const { fake, run, queryClient, user, stub, rerender } = setup();
    fake.focusError = { status: 502, error: "herdr_error", message: "herdr no responde" };
    stub();
    await user.click(screen.getByRole("button"));
    await screen.findByRole("alert");

    const next = { ...run, id: "run-nuevo", herdrPane: "p-9", herdrName: "t-nuevo" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <PaneFocusButton run={next} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Enfocar pane p-9 en herdr" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a Run without herdrPane shows «—» as text, without a button", () => {
    setup({ herdrPane: null });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("a Run without herdrName shows «—» as text, without a button", () => {
    setup({ herdrName: null });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
