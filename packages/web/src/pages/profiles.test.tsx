import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { LANGUAGE_KEY } from "../lib/i18n.ts";

async function openCreate(fake = new FakeApi()) {
  const app = renderApp("/profiles", fake);
  await app.user.click(await screen.findByRole("button", { name: "Nuevo perfil" }));
  return { ...app, dialog: within(await screen.findByRole("dialog", { name: "Nuevo perfil" })) };
}

describe("Profiles tab", () => {
  it("has its own tab in the header and an empty state", async () => {
    renderApp("/profiles");
    expect(await screen.findByRole("heading", { name: "Perfiles de agente" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Perfiles" })).toBeTruthy();
    expect(screen.getByText(/Todavía no hay perfiles/)).toBeTruthy();
  });

  it("lists each profile with its models in order, primary first", async () => {
    const fake = new FakeApi();
    fake.addProfile({
      name: "Mixto",
      models: [
        { kind: "claude", model: "opus", effort: "high", args: [] },
        { kind: "codex", args: [] },
      ],
    });
    renderApp("/profiles", fake);

    await screen.findByText("Mixto");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Principal");
    expect(items[0]?.textContent).toContain("claude · opus · esfuerzo high");
    expect(items[1]?.textContent).toContain("Alternativa 1");
    expect(items[1]?.textContent).toContain("codex · modelo por defecto");
  });

  it("creates a profile with a primary and a fallback and lists it", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openCreate(fake);

    await user.type(dialog.getByLabelText("Nombre del perfil"), "Rápido");
    await user.type(dialog.getByLabelText("Nombre del modelo 1"), "sonnet");
    await user.click(dialog.getByRole("button", { name: "Añadir modelo" }));
    await user.selectOptions(dialog.getByLabelText("Proveedor del modelo 2"), "codex");
    await user.type(dialog.getByLabelText("Nombre del modelo 2"), "gpt-5");
    await user.selectOptions(dialog.getByLabelText("Esfuerzo del modelo 2"), "high");
    await user.type(
      dialog.getByLabelText("Argumentos de CLI del modelo 2 (uno por línea)"),
      "--full-auto",
    );
    await user.click(dialog.getByRole("button", { name: "Crear perfil" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Rápido")).toBeTruthy();
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "Rápido",
      models: [
        { kind: "claude", model: "sonnet", args: [] },
        { kind: "codex", model: "gpt-5", effort: "high", args: ["--full-auto"] },
      ],
    });
  });

  it("reorders and removes models when editing", async () => {
    const fake = new FakeApi();
    const profile = fake.addProfile({
      name: "Orden",
      models: [
        { kind: "claude", model: "opus", args: [] },
        { kind: "codex", model: "gpt-5", args: [] },
        { kind: "copilot", args: [] },
      ],
    });
    const { user } = renderApp("/profiles", fake);
    await user.click(await screen.findByRole("button", { name: "Editar perfil Orden" }));
    const form = within(await screen.findByRole("dialog", { name: "Editar perfil" }));

    // The primary cannot go up and the last one cannot go down.
    expect(form.getByRole("button", { name: "Subir el modelo 1" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(form.getByRole("button", { name: "Bajar el modelo 3" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(form.getByRole("button", { name: "Subir el modelo 2" }));
    await user.click(form.getByRole("button", { name: "Quitar el modelo 3" }));
    await user.click(form.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const request = fake.requests.find((r) => r.method === "PATCH");
    expect(request?.path).toBe(`/api/agent-profiles/${profile.id}`);
    expect(request?.body).toEqual({
      name: "Orden",
      models: [
        { kind: "codex", model: "gpt-5", args: [] },
        { kind: "claude", model: "opus", args: [] },
      ],
    });
  });

  it("the last remaining model cannot be removed and at most 10 can be added", async () => {
    const { user, dialog } = await openCreate();
    expect(
      dialog.getByRole("button", { name: "Quitar el modelo 1" }).hasAttribute("disabled"),
    ).toBe(true);
    for (let i = 0; i < 9; i++)
      await user.click(dialog.getByRole("button", { name: "Añadir modelo" }));
    expect(dialog.getByRole("button", { name: "Añadir modelo" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(dialog.getByText("Un perfil admite como máximo 10 modelos.")).toBeTruthy();
  });

  it("shows the server's validation error (reserved flag) and keeps the form open", async () => {
    const fake = new FakeApi();
    const { user, dialog } = await openCreate(fake);

    await user.type(dialog.getByLabelText("Nombre del perfil"), "Malo");
    await user.selectOptions(dialog.getByLabelText("Esfuerzo del modelo 1"), "high");
    await user.type(
      dialog.getByLabelText("Argumentos de CLI del modelo 1 (uno por línea)"),
      "--effort\nlow",
    );
    await user.click(dialog.getByRole("button", { name: "Crear perfil" }));

    expect((await screen.findByRole("alert")).textContent).toContain("--effort");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fake.profiles).toEqual([]);
  });

  it("shows a repeated name error", async () => {
    const fake = new FakeApi();
    fake.addProfile({ name: "Repetido" });
    const { user, dialog } = await openCreate(fake);

    await user.type(dialog.getByLabelText("Nombre del perfil"), "Repetido");
    await user.click(dialog.getByRole("button", { name: "Crear perfil" }));

    expect((await screen.findByRole("alert")).textContent).toContain("name: ");
  });

  it("a model whose provider is disabled in Settings is shown as disabled and links to Settings", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: true, copilot: false, codex: true };
    fake.addProfile({
      name: "Con copilot",
      models: [
        { kind: "claude", args: [] },
        { kind: "copilot", args: [] },
      ],
    });
    const { user } = renderApp("/profiles", fake);

    const badge = await screen.findByText("Proveedor deshabilitado: se omite");
    expect(screen.getAllByText("Proveedor deshabilitado: se omite")).toHaveLength(1);
    expect(badge.closest("li")?.textContent).toContain("copilot");
    expect(screen.getByRole("link", { name: "Habilitar en Settings" }).getAttribute("href")).toBe(
      "/settings",
    );

    await user.click(screen.getByRole("button", { name: "Editar perfil Con copilot" }));
    expect(
      await screen.findByText("Este proveedor está deshabilitado en Settings: el modelo se omite."),
    ).toBeTruthy();
  });

  it("deletes an unused profile after confirming", async () => {
    const fake = new FakeApi();
    const profile = fake.addProfile({ name: "Sobra" });
    const { user } = renderApp("/profiles", fake);

    await user.click(await screen.findByRole("button", { name: "Eliminar perfil Sobra" }));
    const dialog = await screen.findByRole("dialog", { name: "Eliminar perfil" });
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Sobra")).toBeNull();
    expect(fake.requests.find((r) => r.method === "DELETE")?.path).toBe(
      `/api/agent-profiles/${profile.id}`,
    );
  });

  it("a profile in use cannot be deleted: the dialog lists the projects and phases", async () => {
    const fake = new FakeApi();
    const profile = fake.addProfile({ name: "En uso" });
    fake.addProject({
      name: "proyecto-a",
      agentProfiles: { refine: profile.id, implement: profile.id, verify: null, deliver: null },
    });
    const { user } = renderApp("/profiles", fake);

    await user.click(await screen.findByRole("button", { name: "Eliminar perfil En uso" }));
    const dialog = await screen.findByRole("dialog", { name: "Eliminar perfil" });
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se puede eliminar: lo usan estos proyectos");
    expect(alert.textContent).toContain("proyecto-a: refine, implement");
    expect(fake.profiles).toHaveLength(1);
  });
});

describe("profile texts in English", () => {
  it("the tab, the form and the delete dialog speak English", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    const fake = new FakeApi();
    fake.addProfile({ name: "Fast" });
    const { user } = renderApp("/profiles", fake);

    expect(await screen.findByRole("heading", { name: "Agent profiles" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profiles" })).toBeTruthy();
    expect(screen.getByText("Primary")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit profile Fast" }));
    const form = within(await screen.findByRole("dialog", { name: "Edit profile" }));
    expect(form.getByLabelText("Model 1 provider")).toBeTruthy();
    expect(form.getByRole("button", { name: "Add model" })).toBeTruthy();
    await user.click(form.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Delete profile Fast" }));
    expect(await screen.findByRole("dialog", { name: "Delete profile" })).toBeTruthy();
  });
});
