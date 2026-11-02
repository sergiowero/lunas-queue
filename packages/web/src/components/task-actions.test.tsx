import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { PauseTaskButton, ResumeTaskButton } from "./task-actions.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup(state: "draft" | "paused" = "draft") {
  const fake = new FakeApi();
  const task = fake.addTask(fake.addProject().id, { intent: "Migrar", state, subState: null });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  vi.stubGlobal("fetch", fake.fetch);
  const ui = (variant: "text" | "icon", Button: typeof PauseTaskButton) => (
    <QueryClientProvider client={queryClient}>
      <Button task={task} variant={variant} />
    </QueryClientProvider>
  );
  return { fake, task, invalidate, user: userEvent.setup(), ui, render };
}

describe("PauseTaskButton", () => {
  it("text variant: pause icon, name Pausar tarea and visible text", () => {
    const s = setup();
    const { container } = s.render(s.ui("text", PauseTaskButton));
    const button = screen.getByRole("button", { name: "Pausar tarea" });
    expect(button.textContent).toBe("Pausar tarea");
    expect(container.querySelector('svg[data-icon="pause"]')).not.toBeNull();
  });

  it("icon variant: no visible text and with the task's name in the aria-label", () => {
    const s = setup();
    s.render(s.ui("icon", PauseTaskButton));
    const button = screen.getByRole("button", { name: "Pausar tarea Migrar" });
    expect(button.textContent).toBe("");
    expect(button.querySelector('svg[data-icon="pause"]')).not.toBeNull();
  });

  it("on click it asks for the pause and invalidates task, queue and tasks", async () => {
    const s = setup();
    s.render(s.ui("icon", PauseTaskButton));
    await s.user.click(screen.getByRole("button", { name: "Pausar tarea Migrar" }));
    await waitFor(() => expect(s.fake.task(s.task.id).state).toBe("paused"));
    expect(s.fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/tasks/${s.task.id}/pause`,
    });
    await waitFor(() =>
      expect(s.invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual(
        expect.arrayContaining([["task", s.task.id], ["queue"], ["tasks"]]),
      ),
    );
  });

  it("it is disabled while the request is pending", async () => {
    const s = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof s.fake.fetch>) => {
      await gate;
      return s.fake.fetch(...args);
    });
    s.render(s.ui("icon", PauseTaskButton));
    const button = screen.getByRole("button", { name: "Pausar tarea Migrar" });
    await s.user.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect(s.fake.task(s.task.id).state).toBe("paused"));
  });

  it("if the API rejects the pause it shows the error with role alert and enables again", async () => {
    const s = setup();
    s.fake.transition(s.task.id, "completed", null);
    s.render(s.ui("icon", PauseTaskButton));
    const button = screen.getByRole("button", { name: "Pausar tarea Migrar" });
    await s.user.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("pause no aplica");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("ResumeTaskButton", () => {
  it("text variant: resume icon and name Reanudar tarea", () => {
    const s = setup("paused");
    const { container } = s.render(s.ui("text", ResumeTaskButton));
    const button = screen.getByRole("button", { name: "Reanudar tarea" });
    expect(button.textContent).toBe("Reanudar tarea");
    expect(container.querySelector('svg[data-icon="resume"]')).not.toBeNull();
  });

  it("icon variant: no visible text and with the task's name", () => {
    const s = setup("paused");
    s.render(s.ui("icon", ResumeTaskButton));
    const button = screen.getByRole("button", { name: "Reanudar tarea Migrar" });
    expect(button.textContent).toBe("");
  });

  it("on click it resumes the task and invalidates task, queue and tasks", async () => {
    const s = setup("draft");
    s.fake.transition(s.task.id, "paused", null, {}, "pause");
    s.render(s.ui("icon", ResumeTaskButton));
    await s.user.click(screen.getByRole("button", { name: "Reanudar tarea Migrar" }));
    await waitFor(() => expect(s.fake.task(s.task.id).state).toBe("draft"));
    expect(s.fake.requests.at(-1)?.path).toBe(`/api/tasks/${s.task.id}/resume`);
    await waitFor(() =>
      expect(s.invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual(
        expect.arrayContaining([["task", s.task.id], ["queue"], ["tasks"]]),
      ),
    );
  });

  it("if the API rejects the resume it shows the error with role alert", async () => {
    const s = setup("draft");
    s.render(s.ui("icon", ResumeTaskButton));
    await s.user.click(screen.getByRole("button", { name: "Reanudar tarea Migrar" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
