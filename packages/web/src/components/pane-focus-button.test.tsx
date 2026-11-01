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
    user: userEvent.setup(),
    ...render(view),
    stub: (f = fake.fetch) => vi.stubGlobal("fetch", f),
  };
}

describe("PaneFocusButton", () => {
  it("es un button con nombre accesible que enfoca el pane en herdr e incluye el pane id", () => {
    const { run } = setup();
    const button = screen.getByRole("button", { name: `Enfocar pane ${run.herdrPane} en herdr` });
    expect(button.textContent).toBe(run.herdrPane);
  });

  it("al hacer clic pide el foco del Run y enfoca su agente", async () => {
    const { fake, run, user, stub } = setup();
    stub();
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(fake.focused).toEqual([run.herdrName]));
    expect(fake.requests.at(-1)?.path).toBe(`/api/runs/${run.id}/focus`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Enter con el foco en el botón lo activa", async () => {
    const { fake, run, user, stub } = setup();
    stub();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.focused).toEqual([run.herdrName]));
  });

  it("queda deshabilitado mientras la petición está en curso", async () => {
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
    [409, "agent_gone", "t1 ya no está en herdr"],
    [502, "herdr_error", "herdr no responde"],
    [503, "focus_unavailable", "focus_unavailable"],
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

  it("un Run sin herdrPane muestra «—» como texto, sin botón", () => {
    setup({ herdrPane: null });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("un Run sin herdrName muestra «—» como texto, sin botón", () => {
    setup({ herdrName: null });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
