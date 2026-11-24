// Where the agent badge shows up (docs/decisions/agent-profiles.md §Appearance): Runs, In progress,
// Inbox, Event log and Spec panel.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  const fast = fake.addProfile({ name: "Rápido", icon: "rocket", color: "teal" });
  const slow = fake.addProfile({ name: "Lento", icon: "leaf", color: "green" });
  return { fake, project, fast, slow };
}

describe("Runs table", () => {
  it("each row shows the badge of its own Run's profile", async () => {
    const { fake, project, fast, slow } = seeded();
    const task = fake.addTask(project.id, { goal: "Dos perfiles", state: "in_progress" });
    const first = fake.startRun(task.id, "refine");
    Object.assign(first, { profileId: fast.id });
    fake.endRun(first.id, {});
    const second = fake.startRun(task.id, "implement");
    Object.assign(second, { profileId: slow.id });
    renderApp(`/tasks/${task.id}`, fake);

    const runs = within(await screen.findByRole("region", { name: "Runs" }));
    const rapido = await runs.findByRole("img", { name: "Agente Rápido" });
    const lento = await runs.findByRole("img", { name: "Agente Lento" });
    expect(rapido.getAttribute("data-icon")).toBe("rocket");
    expect(lento.getAttribute("data-icon")).toBe("leaf");
    const rowOf = (el: HTMLElement) => el.closest("tr") as HTMLElement;
    expect(rowOf(rapido).textContent).toContain("claude · opus");
    expect(rowOf(rapido)).not.toBe(rowOf(lento));
  });

  it("a profiled Run does not look unprofiled when the profiles query fails", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Perfiles caídos", state: "in_progress" });
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    fake.profilesFail = true;
    renderApp(`/tasks/${task.id}`, fake);

    const runs = within(await screen.findByRole("region", { name: "Runs" }));
    expect(await runs.findByRole("img", { name: "Agente no disponible" })).toBeTruthy();
    expect(fake.requests.filter((r) => r.path === "/api/agent-profiles").length).toBeLessThan(5);
    expect(runs.queryByRole("img", { name: /sin perfil/i })).toBeNull();
  });

  it("a Run without profile or with a deleted profile shows a neutral badge with its kind and nothing fails", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { goal: "Sin perfil", state: "in_progress" });
    const orphan = fake.startRun(task.id, "refine");
    Object.assign(orphan, { profileId: crypto.randomUUID() });
    fake.endRun(orphan.id, {});
    fake.startRun(task.id, "implement");
    renderApp(`/tasks/${task.id}`, fake);

    const runs = within(await screen.findByRole("region", { name: "Runs" }));
    const named = () => runs.queryAllByRole("img", { name: "Agente claude, sin perfil" });
    await waitFor(() => expect(named()).toHaveLength(2));
    for (const badge of named()) {
      expect(badge.getAttribute("data-agent-badge")).toBe("neutral");
      expect(badge.textContent).toBe("claude · opus");
    }
  });
});

describe("In progress tab", () => {
  it("the Agent column shows the badge of the latest Run's profile", async () => {
    const { fake, project, fast, slow } = seeded();
    const task = fake.addTask(project.id, { goal: "Tarea viva", state: "in_progress" });
    const old = fake.startRun(task.id, "refine");
    Object.assign(old, { profileId: slow.id });
    fake.endRun(old.id, {});
    const latest = fake.startRun(task.id, "implement");
    Object.assign(latest, { profileId: fast.id });
    renderApp("/in-progress", fake);

    // The cells are rebuilt when the Runs arrive: go from the badge to its row, not the other way.
    const badge = await screen.findByRole("img", { name: "Agente Rápido" });
    const row = badge.closest("tr") as HTMLElement;
    expect(within(row).getByRole("link", { name: "Tarea viva" })).toBeTruthy();
    expect(badge.getAttribute("data-color")).toBe("teal");
    expect(within(row).queryByRole("img", { name: "Agente Lento" })).toBeNull();
  });

  it("a Run with a null or deleted profile shows the neutral badge", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { goal: "Huérfana", state: "in_progress" });
    Object.assign(fake.startRun(task.id, "implement"), { profileId: crypto.randomUUID() });
    renderApp("/in-progress", fake);

    const badge = await screen.findByRole("img", { name: "Agente claude, sin perfil" });
    expect(
      within(badge.closest("tr") as HTMLElement).getByRole("link", { name: "Huérfana" }),
    ).toBeTruthy();
    expect(badge.textContent).toBe("claude · opus");
  });
});

describe("while the profiles load", () => {
  it("a profiled Run shows a loading placeholder, then its badge, never the neutral one", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Cargando", state: "in_progress" });
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    let release = () => {};
    fake.profilesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderApp(`/tasks/${task.id}`, fake);

    const placeholder = await screen.findByRole("img", { name: "Cargando…" });
    expect(placeholder.getAttribute("data-agent-badge")).toBe("loading");
    expect(screen.queryByRole("img", { name: /sin perfil/i })).toBeNull();
    release();
    expect(await screen.findByRole("img", { name: "Agente Rápido" })).toBeTruthy();
  });
});

describe("Inbox", () => {
  it("does not claim «no profile» while the Runs load", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Bloqueada", state: "in_progress" });
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    fake.block(run);
    let release = () => {};
    fake.runsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderApp("/inbox", fake);

    const blocked = within(await screen.findByRole("region", { name: "Agentes bloqueados" }));
    expect(await blocked.findByRole("img", { name: "Cargando…" })).toBeTruthy();
    expect(blocked.queryByRole("img", { name: "Sin perfil de agente" })).toBeNull();
    release();
    expect(await blocked.findByRole("img", { name: "Agente Rápido" })).toBeTruthy();
  });

  it("does not claim «no profile» when the Runs query fails", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Bloqueada", state: "in_progress" });
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    fake.block(run);
    fake.runsFail.add(task.id);
    renderApp("/inbox", fake);

    const blocked = within(await screen.findByRole("region", { name: "Agentes bloqueados" }));
    expect(await blocked.findByRole("img", { name: "Agente no disponible" })).toBeTruthy();
    expect(blocked.queryByRole("img", { name: "Sin perfil de agente" })).toBeNull();
  });

  it("the blocked agent shows the badge of its Run's profile", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Bloqueada", state: "in_progress" });
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    fake.block(run);
    renderApp("/inbox", fake);

    const blocked = within(await screen.findByRole("region", { name: "Agentes bloqueados" }));
    const badge = await blocked.findByRole("img", { name: "Agente Rápido" });
    expect(badge.getAttribute("data-icon")).toBe("rocket");
  });
});

describe("Event log", () => {
  it("shows the badge of the Run's profile on agent events and none on human or system events", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Con eventos", state: "in_progress" });
    fake.event(task.id, "note.before", "agent");
    const run = fake.startRun(task.id, "implement");
    Object.assign(run, { profileId: fast.id });
    fake.event(task.id, "note.agent", "agent");
    fake.event(task.id, "note.human", "human");
    fake.event(task.id, "note.system", "system");
    renderApp(`/tasks/${task.id}`, fake);

    const log = within(await screen.findByRole("region", { name: "Event log" }));
    const rowOf = (type: string) => log.getByText(type).closest("li") as HTMLElement;
    await waitFor(() =>
      expect(within(rowOf("note.agent")).getByRole("img", { name: "Agente Rápido" })).toBeTruthy(),
    );
    expect(within(rowOf("note.human")).queryByRole("img")).toBeNull();
    expect(within(rowOf("note.system")).queryByRole("img")).toBeNull();
    // Written before any Run existed: no agent to attribute it to.
    expect(within(rowOf("note.before")).queryByRole("img")).toBeNull();
  });
});

describe("Spec panel", () => {
  it("shows the badge of the refine Run's profile on an agent version and none on a human one", async () => {
    const { fake, project, fast } = seeded();
    const task = fake.addTask(project.id, { goal: "Con spec", state: "refined" });
    const run = fake.startRun(task.id, "refine");
    Object.assign(run, { profileId: fast.id });
    fake.addSpec(task.id);
    fake.endRun(run.id, {});
    const edited = fake.addSpec(task.id);
    Object.assign(edited, { createdBy: "human" });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = within(await screen.findByRole("region", { name: "Spec" }));
    // The latest version is the human's.
    await spec.findByText("autor: human");
    expect(spec.queryByRole("img", { name: "Agente Rápido" })).toBeNull();
    await user.click(spec.getByRole("button", { name: "v1" }));
    expect(await spec.findByRole("img", { name: "Agente Rápido" })).toBeTruthy();
  });
});
