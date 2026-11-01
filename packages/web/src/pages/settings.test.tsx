import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

const on = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

describe("página Settings", () => {
  it("está enlazada en la navegación y muestra un interruptor por proveedor, ambos encendidos", async () => {
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("link", { name: "Settings" }));
    const claude = await screen.findByRole("switch", { name: "Claude" });
    const copilot = await screen.findByRole("switch", { name: "Copilot" });
    expect(on(claude)).toBe(true);
    expect(on(copilot)).toBe(true);
  });

  it("apagar Claude envía el PUT y el interruptor queda apagado tras recargar", async () => {
    const { user, fake, unmount } = renderApp("/settings");
    await user.click(await screen.findByRole("switch", { name: "Claude" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([
      { method: "PUT", path: "/api/settings/providers", body: { claude: false, copilot: true } },
    ]);
    expect(fake.providers).toEqual({ claude: false, copilot: true });

    // Recargar: una app nueva contra el mismo estado guardado.
    unmount();
    renderApp("/settings", fake);
    expect(on(await screen.findByRole("switch", { name: "Claude" }))).toBe(false);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
  });

  it("muestra el error si el servidor rechaza el cambio y conserva el estado guardado", async () => {
    const fake = new FakeApi();
    fake.providersError = { status: 400, error: "invalid_input", message: "entrada inválida" };
    const { user } = renderApp("/settings", fake);
    await user.click(await screen.findByRole("switch", { name: "Copilot" }));
    expect((await screen.findByRole("alert")).textContent).toContain("entrada inválida");
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
    expect(fake.providers).toEqual({ claude: true, copilot: true });
  });
});

describe("aviso de despacho en pausa", () => {
  it("no aparece mientras haya algún proveedor habilitado", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: false, copilot: true };
    renderApp("/queue", fake);
    await screen.findByRole("link", { name: "Settings" });
    await waitFor(() =>
      expect(fake.requests.some((r) => r.path === "/api/settings/providers")).toBe(true),
    );
    expect(screen.queryByText(/Despacho en pausa/)).toBeNull();
  });

  it.each(["/queue", "/projects", "/settings"])(
    "con ambos proveedores deshabilitados aparece en %s con enlace a Settings",
    async (path) => {
      const fake = new FakeApi();
      fake.providers = { claude: false, copilot: false };
      renderApp(path, fake);
      const banner = await screen.findByRole("status");
      expect(banner.textContent).toMatch(/Despacho en pausa/);
      expect(banner.querySelector('a[href="/settings"]')).not.toBeNull();
    },
  );

  it("desaparece al habilitar un proveedor desde Settings", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: false, copilot: false };
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("status");
    await user.click(await screen.findByRole("switch", { name: "Copilot" }));
    await waitFor(() => expect(screen.queryByText(/Despacho en pausa/)).toBeNull());
  });
});

describe("navegación con Settings", () => {
  it("enlaza Settings y permite desplazar el nav en anchos estrechos", async () => {
    renderApp("/queue", new FakeApi());
    const link = await screen.findByRole("link", { name: "Settings" });
    const nav = link.closest("nav");
    expect(nav?.className).toContain("overflow-x-auto");
    expect(nav?.className).toContain("min-w-0");
    expect(link.className).toContain("shrink-0");
  });
});
