import { PROJECT_COLORS, PROJECT_ICONS } from "@lunasq/schemas";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { dictionaries } from "../lib/dictionary/index.ts";
import { LANGUAGE_KEY } from "../lib/i18n.ts";

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
    const verifyProfile = fake.addProfile({ name: "Verificador" });
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
    await user.selectOptions(form.getByLabelText("Perfil de Verificación"), "Verificador");
    await user.type(form.getByLabelText("Timeout de Implementación (min)"), "60");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "completo",
      repo: "owner/completo",
      baseBranch: "develop",
      localPath: "/repos/completo",
      testCommand: "pnpm test",
      bootstrap: "pnpm install",
      agentProfiles: { verify: verifyProfile.id },
      limits: {
        concurrency: 2,
        maxVerificationIterations: 5,
        phaseTimeoutMinutes: { implement: 60 },
      },
    });
  });

  it("an empty iterations field says it uses the global value and sends no cap", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);
    const field = form.getByLabelText("Iteraciones de verificación") as HTMLInputElement;

    expect(field.placeholder).toBe("valor global");
    expect(field.placeholder).not.toBe("3");
    expect(form.getByText(/valor global de Settings/)).toBeTruthy();

    await user.type(form.getByLabelText("Nombre"), "global");
    await user.type(form.getByLabelText("Repositorio"), "owner/global");
    await user.type(form.getByLabelText("Ruta local"), "/repos/global");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).not.toHaveProperty("limits");
  });

  it("lists the profiles per phase, with a no-profile option, and warns while a phase has none", async () => {
    const fake = new FakeApi();
    fake.addProfile({ name: "Rápido" });
    fake.addProfile({ name: "Profundo" });
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    const select = (await form.findByLabelText("Perfil de Implementación")) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.text)).toEqual([
        "Sin perfil (la fase espera)",
        "Rápido",
        "Profundo",
      ]),
    );
    expect(select.value).toBe("");
    expect(form.getAllByRole("note")).toHaveLength(4);
    expect(form.getByText(/La fase Implementación no tiene perfil/)).toBeTruthy();

    await user.selectOptions(select, "Profundo");

    expect(form.queryByText(/La fase Implementación no tiene perfil/)).toBeNull();
    expect(form.getAllByRole("note")).toHaveLength(3);
  });

  it("sends only the phases with a selected profile and leaves the rest unassigned", async () => {
    const fake = new FakeApi();
    const profile = fake.addProfile({ name: "Rápido" });
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.type(form.getByLabelText("Nombre"), "perfiles");
    await user.type(form.getByLabelText("Repositorio"), "owner/perfiles");
    await user.type(form.getByLabelText("Ruta local"), "/repos/perfiles");
    await user.selectOptions(await form.findByLabelText("Perfil de Implementación"), "Rápido");
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      agentProfiles: { implement: profile.id },
    });
    expect(fake.requests.find((r) => r.method === "POST")?.body).not.toHaveProperty(
      "agentProfiles.verify",
    );
    expect(fake.projects.at(-1)?.agentProfiles).toEqual({
      refine: null,
      implement: profile.id,
      verify: null,
      deliver: null,
    });
  });

  it("warns, with a link to Settings, when the selected profile has models of a disabled provider", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: true, copilot: false, codex: true, opencode: true };
    fake.addProfile({
      name: "Con copilot",
      models: [
        { kind: "claude", args: [] },
        { kind: "copilot", args: [] },
      ],
    });
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);

    await user.selectOptions(await form.findByLabelText("Perfil de Refinamiento"), "Con copilot");

    expect(
      await form.findByText(/Este perfil tiene modelos con proveedor deshabilitado \(copilot\)/),
    ).toBeTruthy();
    expect(form.getByRole("link", { name: "Habilitar en Settings" }).getAttribute("href")).toBe(
      "/settings",
    );
  });

  it("with no profiles yet it says so and links to the Profiles tab", async () => {
    const fake = new FakeApi();
    const { dialog } = await openDialog(fake);
    const form = within(dialog);

    expect(await form.findByText(/Todavía no hay perfiles de agente/)).toBeTruthy();
    expect(form.getByRole("link", { name: "Crear un perfil" }).getAttribute("href")).toBe(
      "/profiles",
    );
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
    const rapido = fake.addProfile({ name: "Rápido" });
    const profundo = fake.addProfile({ name: "Profundo" });
    const project = fake.addProject({
      name: "viejo",
      repo: "owner/viejo",
      baseBranch: "develop",
      localPath: "/repos/viejo",
      testCommand: "pnpm test",
      bootstrap: null,
      agentProfiles: {
        refine: rapido.id,
        implement: profundo.id,
        verify: null,
        deliver: rapido.id,
      },
      limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
    });
    return { fake, project, rapido, profundo, app: renderApp("/projects", fake) };
  }

  it("opens the same form prefilled with the project's data", async () => {
    const { app, rapido, profundo } = setup();
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));

    expect((form.getByLabelText("Nombre") as HTMLInputElement).value).toBe("viejo");
    expect((form.getByLabelText("Repositorio") as HTMLInputElement).value).toBe("owner/viejo");
    expect((form.getByLabelText("Rama base") as HTMLInputElement).value).toBe("develop");
    expect((form.getByLabelText("Ruta local") as HTMLInputElement).value).toBe("/repos/viejo");
    expect((form.getByLabelText("Comando de tests") as HTMLInputElement).value).toBe("pnpm test");
    expect((form.getByLabelText("Bootstrap del worktree") as HTMLInputElement).value).toBe("");
    expect((form.getByLabelText("Concurrencia") as HTMLInputElement).value).toBe("2");
    await waitFor(() =>
      expect((form.getByLabelText("Perfil de Implementación") as HTMLSelectElement).value).toBe(
        profundo.id,
      ),
    );
    expect((form.getByLabelText("Perfil de Refinamiento") as HTMLSelectElement).value).toBe(
      rapido.id,
    );
    expect((form.getByLabelText("Perfil de Verificación") as HTMLSelectElement).value).toBe("");
    expect((form.getByLabelText("Timeout de Implementación (min)") as HTMLInputElement).value).toBe(
      "60",
    );
  });

  it("saves the changes with PATCH, deletes the emptied command and updates the list", async () => {
    const { fake, project, profundo, app } = setup();
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
    // Every phase is sent on edit: the unselected one as null.
    expect(request?.body).toMatchObject({
      agentProfiles: { implement: profundo.id, verify: null },
    });
  });

  it("choosing 'no profile' unassigns the phase and the project shows the missing-profile badge", async () => {
    const { fake, project, app } = setup();
    expect((await screen.findAllByText("Sin perfil: Verificación")).length).toBe(1);
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));

    await app.user.selectOptions(await form.findByLabelText("Perfil de Refinamiento"), "");
    await app.user.click(form.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.projects.find((p) => p.id === project.id)?.agentProfiles.refine).toBeNull();
    expect(await screen.findByText("Sin perfil: Refinamiento, Verificación")).toBeTruthy();
  });

  it("the link of a held task opens the edit form of that project", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "otro" });
    const project = fake.addProject({ name: "retenido" });
    renderApp(`/projects?edit=${project.id}`, fake);

    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));
    expect((form.getByLabelText("Nombre") as HTMLInputElement).value).toBe("retenido");
  });

  it("the missing-profile badge wraps inside the card instead of overflowing on narrow screens", async () => {
    setup();
    const badge = await screen.findByText("Sin perfil: Verificación");
    expect(badge.className).toContain("whitespace-normal");
    expect(badge.className).not.toContain("whitespace-nowrap");
    expect(badge.className).toContain("max-w-full");
  });

  it("a profile that disappeared answers profile_not_found and the form shows it", async () => {
    const { fake, app } = setup();
    await app.user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));
    await waitFor(() =>
      expect((form.getByLabelText("Perfil de Implementación") as HTMLSelectElement).value).not.toBe(
        "",
      ),
    );
    fake.profiles.splice(0, fake.profiles.length);

    await app.user.click(form.getByRole("button", { name: "Guardar cambios" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "El perfil elegido ya no existe.",
    );
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

describe("project icon and color pickers in the form", () => {
  async function createForm(fake = new FakeApi()) {
    const { user, dialog } = await openDialog(fake);
    const form = within(dialog);
    await user.type(form.getByLabelText("Nombre"), "mi-proyecto");
    await user.type(form.getByLabelText("Repositorio"), "owner/repo");
    await user.type(form.getByLabelText("Ruta local"), "/repos/mi-proyecto");
    return { fake, user, form };
  }

  async function editForm(fake: FakeApi) {
    const { user } = renderApp("/projects", fake);
    await user.click(await screen.findByRole("button", { name: "Editar viejo" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar proyecto" }));
    return { user, form };
  }

  const radios = (form: ReturnType<typeof within>, group: string) =>
    within(form.getByRole("radiogroup", { name: group })).getAllByRole("radio");

  it("the icon picker shows the actual glyph of every icon and none is checked by default", async () => {
    const { form } = await createForm();
    const options = radios(form, "Icono");

    expect(options).toHaveLength(1 + PROJECT_ICONS.length);
    expect((form.getByRole("radio", { name: "Sin icono" }) as HTMLInputElement).checked).toBe(true);
    for (const key of PROJECT_ICONS) {
      const radio = form.getByRole("radio", { name: dictionaries.es.projectForm.iconNames[key] });
      const glyph = radio.closest("label")?.querySelector("svg");
      expect(glyph?.getAttribute("data-icon")).toBe(`project-${key}`);
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    expect(form.getByRole("radio", { name: "Pokéball" })).toBeTruthy();
  });

  it("the color picker shows a swatch of the actual color of every color and none is checked", async () => {
    const { form } = await createForm();

    expect(radios(form, "Color")).toHaveLength(1 + PROJECT_COLORS.length);
    expect((form.getByRole("radio", { name: "Sin color" }) as HTMLInputElement).checked).toBe(true);
    for (const key of PROJECT_COLORS) {
      const radio = form.getByRole("radio", { name: dictionaries.es.projectForm.colorNames[key] });
      const swatch = radio.closest("label")?.querySelector("[data-swatch]");
      expect(swatch?.getAttribute("data-swatch")).toBe(key);
      expect(swatch?.className).toContain(`bg-project-${key}`);
    }
  });

  it("creating with the icon and the color left as none does not send them", async () => {
    const { fake, user, form } = await createForm();
    expect((form.getByRole("radio", { name: "Sin icono" }) as HTMLInputElement).checked).toBe(true);
    expect((form.getByRole("radio", { name: "Sin color" }) as HTMLInputElement).checked).toBe(true);
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = fake.requests.find((r) => r.method === "POST")?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("icon");
    expect(body).not.toHaveProperty("color");
  });

  it("creating with the pokeball and teal sends their keys and the list shows the glyph", async () => {
    const { fake, user, form } = await createForm();
    await user.click(form.getByRole("radio", { name: "Pokéball" }));
    await user.click(form.getByRole("radio", { name: "Turquesa" }));
    await user.click(form.getByRole("button", { name: "Crear proyecto" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      icon: "pokeball",
      color: "teal",
    });
    const link = await screen.findByRole("link", { name: "mi-proyecto" });
    expect(link.querySelector("svg")?.getAttribute("data-icon")).toBe("project-pokeball");
    expect(link.firstElementChild?.className).toContain("text-project-teal");
  });

  it("editing a project that has them checks its icon and its color", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "viejo", icon: "database", color: "violet" });
    const { form } = await editForm(fake);

    const checked = (name: string) =>
      (form.getByRole("radio", { name }) as HTMLInputElement).checked;
    expect(checked("Base de datos")).toBe(true);
    expect(checked("Violeta")).toBe(true);
    expect(checked("Sin icono")).toBe(false);
    expect(checked("Sin color")).toBe(false);
  });

  it("picking none for both on edit sends null for each and the project ends up without them", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "viejo", icon: "rocket", color: "teal" });
    const { user, form } = await editForm(fake);

    await user.click(form.getByRole("radio", { name: "Sin icono" }));
    await user.click(form.getByRole("radio", { name: "Sin color" }));
    await user.click(form.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({
      icon: null,
      color: null,
    });
    expect(fake.projects.find((p) => p.id === project.id)).toMatchObject({
      icon: null,
      color: null,
    });
  });

  it("editing only the color keeps sending the icon as it was", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "viejo", icon: "rocket", color: "teal" });
    const { user, form } = await editForm(fake);

    await user.click(form.getByRole("radio", { name: "Rosa" }));
    await user.click(form.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({
      icon: "rocket",
      color: "pink",
    });
  });

  it("the preview shows a placeholder name, then the typed name with the chosen glyph and color", async () => {
    const { user, form } = await createForm();
    const preview = () => form.getByTestId("project-preview");
    await user.clear(form.getByLabelText("Nombre"));

    expect(preview().textContent).toBe("Proyecto");
    expect(preview().querySelector("svg")).toBeNull();

    await user.type(form.getByLabelText("Nombre"), "mi-proyecto");
    await user.click(form.getByRole("radio", { name: "Pokéball" }));
    await user.click(form.getByRole("radio", { name: "Violeta" }));

    expect(preview().textContent).toBe("mi-proyecto");
    expect(preview().querySelector("svg")?.getAttribute("data-icon")).toBe("project-pokeball");
    expect(preview().querySelector(".text-project-violet")).toBeTruthy();
  });

  it("offers every icon and color in Spanish, each with a 'none' option first", async () => {
    const { form } = await createForm();
    const names = (group: string) => radios(form, group).map((r) => r.getAttribute("aria-label"));

    expect(names("Icono")).toEqual([
      "Sin icono",
      "Carpeta",
      "Código",
      "Terminal",
      "Globo",
      "Base de datos",
      "Servidor",
      "Cohete",
      "Libro",
      "Paquete",
      "Móvil",
      "Nube",
      "Rayo",
      "Pokéball",
    ]);
    expect(names("Color")).toEqual([
      "Sin color",
      "Rojo",
      "Naranja",
      "Ámbar",
      "Verde",
      "Turquesa",
      "Azul",
      "Violeta",
      "Rosa",
    ]);
  });

  it("offers them in English when the UI is in English", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    const app = renderApp("/projects", new FakeApi());
    await app.user.click(await screen.findByRole("button", { name: "New project" }));
    const form = within(await screen.findByRole("dialog", { name: "New project" }));
    const names = (group: string) => radios(form, group).map((r) => r.getAttribute("aria-label"));

    expect(names("Icon")).toEqual([
      "No icon",
      "Folder",
      "Code",
      "Terminal",
      "Globe",
      "Database",
      "Server",
      "Rocket",
      "Book",
      "Package",
      "Mobile",
      "Cloud",
      "Bolt",
      "Pokeball",
    ]);
    expect(names("Color")).toEqual([
      "No color",
      "Red",
      "Orange",
      "Amber",
      "Green",
      "Teal",
      "Blue",
      "Violet",
      "Pink",
    ]);
  });
});
