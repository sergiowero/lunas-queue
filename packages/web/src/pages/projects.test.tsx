import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

async function openDialog(fake: FakeApi) {
  const app = renderApp("/projects", fake);
  await app.user.click(await screen.findByRole("button", { name: "Nuevo proyecto" }));
  return { ...app, dialog: await screen.findByRole("dialog", { name: "Nuevo proyecto" }) };
}

describe("project creation", () => {
  it("creates the project with the basic fields and shows it in the list", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);

    await user.type(within(dialog).getByLabelText("Nombre"), "mi-proyecto");
    await user.type(within(dialog).getByLabelText("Repositorio"), "owner/repo");
    await user.type(within(dialog).getByLabelText("Ruta local"), "/repos/mi-proyecto");
    await user.click(within(dialog).getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("link", { name: "mi-proyecto" })).toBeTruthy();
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "mi-proyecto",
      repo: "owner/repo",
      baseBranch: "main",
      localPath: "/repos/mi-proyecto",
    });
  });

  it("sends commands, limits and per-phase profiles, without the empty fields", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "completo");
    await user.type(form.getByLabelText("Repositorio"), "owner/completo");
    await user.clear(form.getByLabelText("Rama base"));
    await user.type(form.getByLabelText("Rama base"), "develop");
    await user.type(form.getByLabelText("Ruta local"), "/repos/completo");
    await user.type(form.getByLabelText("Comando de tests"), "pnpm test");
    await user.type(form.getByLabelText("Bootstrap del worktree"), "pnpm install");
    await user.type(form.getByLabelText("Concurrencia"), "2");
    await user.type(form.getByLabelText("Iteraciones de verificación"), "5");
    await user.type(form.getByLabelText("Modelo de verify"), "sonnet");
    await user.type(
      form.getByLabelText("Argumentos de CLI para Claude en verify (uno por línea)"),
      "--permission-mode\nauto",
    );
    await user.type(form.getByLabelText("Timeout de implement (min)"), "60");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "completo",
      repo: "owner/completo",
      baseBranch: "develop",
      localPath: "/repos/completo",
      testCommand: "pnpm test",
      bootstrap: "pnpm install",
      agentProfiles: {
        verify: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
      },
      limits: {
        concurrency: 2,
        maxVerificationIterations: 5,
        phaseTimeoutMinutes: { implement: 60 },
      },
    });
  });

  it("sends the per-phase effort only when chosen, and shows it when editing", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "esfuerzo");
    await user.type(form.getByLabelText("Repositorio"), "owner/esfuerzo");
    await user.type(form.getByLabelText("Ruta local"), "/repos/esfuerzo");
    await user.selectOptions(form.getByLabelText("Esfuerzo de implement"), "high");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      agentProfiles: { implement: { kind: "claude", effort: "high", args: [] } },
    });

    expect(fake.requests.find((r) => r.method === "POST")?.body).not.toHaveProperty(
      "agentProfiles.verify",
    );
  });

  it("allows choosing Copilot as a phase's provider", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "copilot-project");
    await user.type(form.getByLabelText("Repositorio"), "owner/copilot-project");
    await user.type(form.getByLabelText("Ruta local"), "/repos/copilot-project");
    await user.selectOptions(form.getByLabelText("Proveedor de implement"), "copilot");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      agentProfiles: { implement: { kind: "copilot", args: [] } },
    });
  });

  it("allows choosing Codex as a phase's provider", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "codex-project");
    await user.type(form.getByLabelText("Repositorio"), "owner/codex-project");
    await user.type(form.getByLabelText("Ruta local"), "/repos/codex-project");
    await user.selectOptions(form.getByLabelText("Proveedor de implement"), "codex");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      agentProfiles: { implement: { kind: "codex", args: [] } },
    });
  });

  it("shows the server's error and leaves the popup open", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "repetido", localPath: "/repos/otro" });
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "repetido");
    await user.type(form.getByLabelText("Repositorio"), "owner/repo");
    await user.type(form.getByLabelText("Ruta local"), "/repos/nuevo");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    expect((await screen.findByRole("alert")).textContent).toContain("ya existe un proyecto");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the server's validation issues", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "malo");
    await user.type(form.getByLabelText("Repositorio"), "sin-owner");
    await user.type(form.getByLabelText("Ruta local"), "/repos/malo");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "repo: repo must be owner/name",
    );
  });

  it("closes with Cancelar and with Escape without creating anything", async () => {
    const fake = new FakeApi();
    const { user } = await openDialog(fake);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Nuevo proyecto" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("project editing", () => {
  function setup() {
    const fake = new FakeApi();
    const project = fake.addProject({
      name: "viejo",
      repo: "owner/viejo",
      baseBranch: "develop",
      localPath: "/repos/viejo",
      testCommand: "pnpm test",
      bootstrap: null,
      agentProfiles: {
        refine: { kind: "claude", args: [] },
        implement: { kind: "claude", model: "opus", args: ["--permission-mode", "auto"] },
        verify: { kind: "claude", args: [] },
        deliver: { kind: "claude", args: [] },
      },
      limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
    });
    return { fake, project, app: renderApp("/projects", fake) };
  }

  it("opens the same form prefilled with the project's data", async () => {
    const { app } = setup();
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));

    expect((form.getByLabelText("Nombre") as HTMLInputElement).value).toBe("viejo");
    expect((form.getByLabelText("Repositorio") as HTMLInputElement).value).toBe("owner/viejo");
    expect((form.getByLabelText("Rama base") as HTMLInputElement).value).toBe("develop");
    expect((form.getByLabelText("Ruta local") as HTMLInputElement).value).toBe("/repos/viejo");
    expect((form.getByLabelText("Comando de tests") as HTMLInputElement).value).toBe("pnpm test");
    expect((form.getByLabelText("Bootstrap del worktree") as HTMLInputElement).value).toBe("");
    expect((form.getByLabelText("Concurrencia") as HTMLInputElement).value).toBe("2");
    expect((form.getByLabelText("Modelo de implement") as HTMLInputElement).value).toBe("opus");
    expect(
      (
        form.getByLabelText(
          "Argumentos de CLI para Claude en implement (uno por línea)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("--permission-mode\nauto");
    expect((form.getByLabelText("Timeout de implement (min)") as HTMLInputElement).value).toBe(
      "60",
    );
  });

  it("saves the changes with PATCH, deletes the emptied command and updates the list", async () => {
    const { fake, project, app } = setup();
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));

    await app.user.clear(form.getByLabelText("Nombre"));
    await app.user.type(form.getByLabelText("Nombre"), "nuevo");
    await app.user.clear(form.getByLabelText("Comando de tests"));
    await app.user.click(form.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("link", { name: "nuevo" })).toBeTruthy();
    const request = fake.requests.find((r) => r.method === "PATCH");
    expect(request?.path).toBe(`/api/projects/${project.id}`);
    expect(request?.body).toMatchObject({
      name: "nuevo",
      repo: "owner/viejo",
      baseBranch: "develop",
      localPath: "/repos/viejo",
      testCommand: null,
      bootstrap: null,
      limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
    });
    expect(request?.body).toMatchObject({
      agentProfiles: {
        implement: { kind: "claude", model: "opus", args: ["--permission-mode", "auto"] },
      },
    });
  });

  it("shows the error and leaves the form open", async () => {
    const { fake, app } = setup();
    fake.addProject({ name: "ocupado", localPath: "/repos/ocupado" });
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));

    await app.user.clear(form.getByLabelText("Nombre"));
    await app.user.type(form.getByLabelText("Nombre"), "ocupado");
    await app.user.click(form.getByRole("button", { name: "Guardar cambios" }));

    expect((await screen.findByRole("alert")).textContent).toContain("ya existe un proyecto");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("project deletion", () => {
  it("asks for confirmation and deletes the project", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "sobra" });
    fake.addProject({ name: "queda" });
    const { user } = renderApp("/projects", fake);

    await user.click(await screen.findByRole("button", { name: "Eliminar sobra" }));
    const dialog = await screen.findByRole("dialog", { name: "Eliminar proyecto" });
    expect(dialog.textContent).toContain("sobra");
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("link", { name: "sobra" })).toBeNull();
    expect(screen.getByRole("link", { name: "queda" })).toBeTruthy();
    expect(fake.requests.find((r) => r.method === "DELETE")?.path).toBe(
      `/api/projects/${project.id}`,
    );
  });

  it("Cancelar deletes nothing", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "sobra" });
    const { user } = renderApp("/projects", fake);

    await user.click(await screen.findByRole("button", { name: "Eliminar sobra" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "sobra" })).toBeTruthy();
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("shows the error when the project has tasks and does not delete it", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "ocupado" });
    fake.addTask(project.id);
    const { user } = renderApp("/projects", fake);

    await user.click(await screen.findByRole("button", { name: "Eliminar ocupado" }));
    const dialog = await screen.findByRole("dialog", { name: "Eliminar proyecto" });
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "El proyecto tiene tareas y no se puede eliminar.",
    );
    expect(screen.getByRole("link", { name: "ocupado" })).toBeTruthy();
  });
});
