// The project's icon and color wherever a task shows its project (AC-7, AC-8, AC-13).
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

/** Projects: one with icon and color, one with neither. */
function seeded() {
  const fake = new FakeApi();
  const styled = fake.addProject({ name: "estilizado", icon: "rocket", color: "teal" });
  const plain = fake.addProject({ name: "sencillo" });
  return { fake, styled, plain };
}

/** The label that wraps the icon and the name of the project, found by its name within `scope`. */
function labelOf(scope: ReturnType<typeof within>, name: string): HTMLElement {
  const label = scope.getByText(name).parentElement;
  expect(label).not.toBeNull();
  return label as HTMLElement;
}

function expectStyled(label: HTMLElement) {
  const icon = label.querySelector("svg");
  expect(icon?.getAttribute("data-icon")).toBe("project-rocket");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(label.className).toContain("text-project-teal");
}

function expectPlain(label: HTMLElement) {
  expect(label.querySelector("svg")).toBeNull();
  expect(label.className).not.toContain("text-project-");
}

describe("project label in the views", () => {
  it("queue: shows the project with its icon and color, or only its name", async () => {
    const { fake, styled, plain } = seeded();
    const a = fake.addTask(styled.id, { goal: "Una" });
    const b = fake.addTask(plain.id, { goal: "Otra" });
    fake.queue = [a, b].map((task) => ({
      task,
      ready: true,
      score: 1,
      effectivePriority: 1,
      usage,
    }));
    renderApp("/queue", fake);

    const table = within(await screen.findByRole("table"));
    expectStyled(labelOf(table, "estilizado"));
    expectPlain(labelOf(table, "sencillo"));
  });

  it("in progress: shows the project with its icon and color, or only its name", async () => {
    const { fake, styled, plain } = seeded();
    fake.addTask(styled.id, { goal: "Una", state: "in_progress", subState: "running" });
    fake.addTask(plain.id, { goal: "Otra", state: "in_progress", subState: "running" });
    renderApp("/in-progress", fake);

    const table = within(await screen.findByRole("table"));
    expectStyled(labelOf(table, "estilizado"));
    expectPlain(labelOf(table, "sencillo"));
  });

  it("completed: shows the project with its icon and color, or only its name", async () => {
    const { fake, styled, plain } = seeded();
    fake.addTask(styled.id, { goal: "Una", state: "completed", subState: null });
    fake.addTask(plain.id, { goal: "Otra", state: "completed", subState: null });
    renderApp("/completed", fake);

    const table = within(await screen.findByRole("table"));
    expectStyled(labelOf(table, "estilizado"));
    expectPlain(labelOf(table, "sencillo"));
  });

  it("completed: the project filter still lists and filters by the project name", async () => {
    const { fake, styled, plain } = seeded();
    fake.addTask(styled.id, { goal: "Una", state: "completed", subState: null });
    fake.addTask(plain.id, { goal: "Otra", state: "completed", subState: null });
    const { user } = renderApp("/completed", fake);

    const filter = await screen.findByLabelText("Proyecto");
    expect(within(filter).getByRole("option", { name: "estilizado" })).toBeTruthy();
    await user.selectOptions(filter, "estilizado");
    await waitFor(() => {
      const table = within(screen.getByRole("table"));
      expect(table.getByText("estilizado")).toBeTruthy();
      expect(table.queryByText("sencillo")).toBeNull();
    });
  });

  it("inbox: shows the project of a spec to approve with its icon and color", async () => {
    const { fake, styled, plain } = seeded();
    for (const [project, goal] of [
      [styled, "Con estilo"],
      [plain, "Sin estilo"],
    ] as const) {
      const task = fake.addTask(project.id, { goal });
      fake.addSpec(task.id);
      fake.transition(task.id, "refined", null);
    }
    renderApp("/inbox", fake);

    const specs = within(await screen.findByRole("region", { name: "Specs por aprobar" }));
    const styledRow = within(
      (await specs.findByRole("link", { name: "Con estilo" })).closest("li") as HTMLElement,
    );
    const plainRow = within(
      (await specs.findByRole("link", { name: "Sin estilo" })).closest("li") as HTMLElement,
    );
    expectStyled(labelOf(styledRow, "estilizado"));
    expectPlain(labelOf(plainRow, "sencillo"));
  });

  it("task detail: shows the project with its icon and color, as a link named after the project", async () => {
    const { fake, styled } = seeded();
    const task = fake.addTask(styled.id, { goal: "Detalle" });
    renderApp(`/tasks/${task.id}`, fake);

    const link = await screen.findByRole("link", { name: "estilizado" });
    expect(link.getAttribute("href")).toBe(`/projects/${styled.id}`);
    expectStyled(link.firstElementChild as HTMLElement);
  });

  it("task detail: a project without icon or color shows only its name", async () => {
    const { fake, plain } = seeded();
    const task = fake.addTask(plain.id, { goal: "Detalle" });
    renderApp(`/tasks/${task.id}`, fake);

    const link = await screen.findByRole("link", { name: "sencillo" });
    expectPlain(link.firstElementChild as HTMLElement);
  });

  it("projects list: each card shows the project with its icon and color", async () => {
    const { fake } = seeded();
    renderApp("/projects", fake);

    const styledLink = await screen.findByRole("link", { name: "estilizado" });
    expectStyled(styledLink.firstElementChild as HTMLElement);
    const plainLink = await screen.findByRole("link", { name: "sencillo" });
    expectPlain(plainLink.firstElementChild as HTMLElement);
  });

  it("board header: shows the project with its icon and color and keeps the name as the heading", async () => {
    const { fake, styled } = seeded();
    renderApp(`/projects/${styled.id}`, fake);

    const heading = await screen.findByRole("heading", { name: "estilizado" });
    expectStyled(heading.firstElementChild as HTMLElement);
  });
});
