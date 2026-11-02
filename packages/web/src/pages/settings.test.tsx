import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

const on = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

describe("Settings page", () => {
  it("is linked in the navigation and shows an enabled switch for every provider", async () => {
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("link", { name: "Settings" }));
    const claude = await screen.findByRole("switch", { name: "Claude" });
    const copilot = await screen.findByRole("switch", { name: "Copilot" });
    const codex = await screen.findByRole("switch", { name: "Codex" });
    expect(on(claude)).toBe(true);
    expect(on(copilot)).toBe(true);
    expect(on(codex)).toBe(true);
  });

  it("turning Claude off sends the PUT and the switch stays off after reloading", async () => {
    const { user, fake, unmount } = renderApp("/settings");
    await user.click(await screen.findByRole("switch", { name: "Claude" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([
      { method: "PUT", path: "/api/settings/providers", body: { claude: false } },
    ]);
    expect(fake.providers).toEqual({ claude: false, copilot: true, codex: true });

    // Reload: a new app against the same saved state.
    unmount();
    renderApp("/settings", fake);
    expect(on(await screen.findByRole("switch", { name: "Claude" }))).toBe(false);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
    expect(on(screen.getByRole("switch", { name: "Codex" }))).toBe(true);
  });

  it("turning Codex off persists only the Codex setting", async () => {
    const { user, fake } = renderApp("/settings");
    await user.click(await screen.findByRole("switch", { name: "Codex" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Codex" }))).toBe(false));
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([
      { method: "PUT", path: "/api/settings/providers", body: { codex: false } },
    ]);
    expect(fake.providers).toEqual({ claude: true, copilot: true, codex: false });
  });

  it("with the keyboard, the saving switch stays focusable and is not pressed twice", async () => {
    const fake = new FakeApi();
    let release = () => {};
    fake.holdProvidersPut = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderApp("/settings", fake);
    const claude = await screen.findByRole("switch", { name: "Claude" });
    claude.focus();

    await user.keyboard(" ");

    // In flight: aria-disabled and not `disabled`, which would take the button out of the tab order and
    // drop focus when finished.
    await waitFor(() => expect(claude.getAttribute("aria-disabled")).toBe("true"));
    expect(claude.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(claude);
    await user.keyboard(" ");
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);

    release();
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    await waitFor(() => expect(claude.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(claude);
    expect(fake.providers).toEqual({ claude: false, copilot: true, codex: true });
  });

  it("a change from another tab is not overwritten: each switch sends only its provider", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    // Another tab turns Claude off while this one keeps the old view (Claude on).
    fake.providers = { claude: false, copilot: true, codex: true };

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    expect(fake.providers).toEqual({ claude: false, copilot: false, codex: true });
    expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false);
  });

  it("the response of an old PUT does not restore a view earlier than a later change", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    // Another tab turns Claude off right after this PUT is saved and before it responds.
    fake.afterProvidersPut = () => {
      fake.providers = { ...fake.providers, claude: false };
    };

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
  });

  it("an error when reading again keeps the switches with the last state and warns", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    // The PUT was saved: the notice says so and does not talk about a failed change (see the next test).
    const alert = await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });
    expect(alert.getAttribute("role")).toBe("alert");
    // The switches keep the last state read: both are still on.
    expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(true);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
  });

  it("a failed read after a successful re-read does not say the change was not read", async () => {
    const fake = new FakeApi();
    const { user, refresh } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;
    await user.click(screen.getByRole("switch", { name: "Copilot" }));
    await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });

    // A read after the PUT succeeds: the switches already reflect what was saved.
    fake.providersReadFails = false;
    await refresh();
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    expect(screen.queryByText(/El cambio se guardó/)).toBeNull();

    // Another read fails afterwards: it is a failure unrelated to the change, with the generic text.
    fake.providersReadFails = true;
    await refresh();
    const alert = await screen.findByText(/No se pudo actualizar la configuración/);
    expect(alert.textContent).not.toMatch(/El cambio se guardó/);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false);
  });

  it("if the PUT is saved but the re-read fails, it warns that the change was saved and not that it failed", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    const alert = await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });
    expect(alert.textContent).toMatch(/no se pudo leer el estado/);
    expect(alert.textContent).not.toMatch(/No se pudo actualizar la configuración/);
    expect(fake.providers).toEqual({ claude: true, copilot: false, codex: true });
  });

  it("shows the error if the server rejects the change and keeps the saved state", async () => {
    const fake = new FakeApi();
    fake.providersError = { status: 400, error: "invalid_input", message: "entrada inválida" };
    const { user } = renderApp("/settings", fake);
    await user.click(await screen.findByRole("switch", { name: "Copilot" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Los datos enviados no son válidos.",
    );
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
    expect(fake.providers).toEqual({ claude: true, copilot: true, codex: true });
  });
});

describe("Concurrencia section", () => {
  const field = () => screen.findByRole("spinbutton", { name: /Agentes concurrentes/ });

  it("shows the current limit in a numeric field with its Guardar button", async () => {
    renderApp("/settings");
    expect((await field()).getAttribute("type")).toBe("number");
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
    expect(screen.getByRole("heading", { name: "Concurrencia" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeTruthy();
  });

  it("typing 3 and saving sends the PUT, shows 3 after re-reading and disables Guardar while saving", async () => {
    const fake = new FakeApi();
    let release = () => {};
    fake.holdConcurrencyPut = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3");

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    release();
    await waitFor(() => expect(fake.concurrency).toEqual({ globalConcurrency: 3 }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([
      { method: "PUT", path: "/api/settings/concurrency", body: { globalConcurrency: 3 } },
    ]);
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "3");
  });

  it("survives a reload: a new app reads the saved limit", async () => {
    const fake = new FakeApi();
    const { user, unmount } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "7");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(fake.concurrency).toEqual({ globalConcurrency: 7 }));
    unmount();
    renderApp("/settings", fake);
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "7");
  });

  it.each([
    ["vacío", ""],
    ["0", "0"],
    ["mayor a 50", "51"],
    ["decimal", "1.5"],
  ])(
    "con un valor %s no envía nada y muestra un mensaje asociado al campo",
    async (_name, typed) => {
      const fake = new FakeApi();
      const { user } = renderApp("/settings", fake);
      const input = (await field()) as HTMLInputElement;
      await user.clear(input);
      if (typed) await user.type(input, typed);

      await user.click(screen.getByRole("button", { name: "Guardar" }));

      const message = await screen.findByText(/entero entre 1 y 50/);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(message.id);
      expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([]);
      expect(fake.concurrency).toEqual({ globalConcurrency: 5 });
    },
  );

  it("the validation message disappears when correcting the value and saving", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText(/entero entre 1 y 50/);

    await user.type(input, "4");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(fake.concurrency).toEqual({ globalConcurrency: 4 }));
    await waitFor(() => expect(screen.queryByText(/entero entre 1 y 50/)).toBeNull());
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("if saving fails it shows a notice, keeps the last value read and the providers keep working", async () => {
    const fake = new FakeApi();
    fake.concurrencyError = { status: 500, error: "internal", message: "disco lleno" };
    const { user } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3");

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disco lleno");
    expect(alert.textContent).toContain("sigue vigente 5");
    expect(fake.concurrency).toEqual({ globalConcurrency: 5 });
    // The providers keep working.
    await user.click(screen.getByRole("switch", { name: "Claude" }));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    expect(fake.providers).toEqual({ claude: false, copilot: true, codex: true });
  });

  it("if the PUT is saved but the re-read fails, the field shows the saved value and the notice says it was saved", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3");
    fake.concurrencyReadFails = true;

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByText(/El límite se guardó/, {}, { timeout: 5000 });
    expect(alert.textContent).toContain("3");
    expect(alert.textContent).not.toMatch(/No se pudo (guardar|actualizar)/);
    expect(fake.concurrency).toEqual({ globalConcurrency: 3 });
    expect(((await field()) as HTMLInputElement).value).toBe("3");
    expect((screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  }, 15000);

  it("if a save fails after one that was saved without being re-read, the notice shows the saved value", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    const input = (await field()) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3");
    fake.concurrencyReadFails = true;
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText(/El límite se guardó/, {}, { timeout: 5000 });

    fake.concurrencyError = { status: 500, error: "internal", message: "disco lleno" };
    await user.clear(input);
    await user.type(input, "4");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByText(/No se pudo guardar el límite/, {}, { timeout: 5000 });
    expect(alert.textContent).toContain("sigue vigente 3");
    expect(alert.textContent).not.toContain("sigue vigente 5");
    expect(fake.concurrency).toEqual({ globalConcurrency: 3 });
  }, 20000);

  it("if the read fails it shows a notice and the providers section keeps working", async () => {
    const fake = new FakeApi();
    fake.concurrencyReadFails = true;
    const { user } = renderApp("/settings", fake);

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("no connection");
    await user.click(await screen.findByRole("switch", { name: "Claude" }));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
  });

  it("if a re-read fails it keeps the last value read and warns", async () => {
    const fake = new FakeApi();
    const { refresh } = renderApp("/settings", fake);
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
    fake.concurrencyReadFails = true;

    await refresh();

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("no connection");
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
  });
});

describe("paused dispatch notice", () => {
  it("does not appear while any provider is enabled", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: false, copilot: true, codex: true };
    renderApp("/queue", fake);
    await screen.findByRole("link", { name: "Settings" });
    await waitFor(() =>
      expect(fake.requests.some((r) => r.path === "/api/settings/providers")).toBe(true),
    );
    expect(screen.queryByText(/Despacho en pausa/)).toBeNull();
  });

  it.each(["/queue", "/projects", "/settings"])(
    "con todos los proveedores deshabilitados aparece en %s con enlace a Settings",
    async (path) => {
      const fake = new FakeApi();
      fake.providers = { claude: false, copilot: false, codex: false };
      renderApp(path, fake);
      const banner = await screen.findByRole("status");
      expect(banner.textContent).toMatch(/Despacho en pausa/);
      expect(banner.querySelector('a[href="/settings"]')).not.toBeNull();
    },
  );

  it("warns that the state is unknown if the configuration cannot be read", async () => {
    const fake = new FakeApi();
    fake.providersReadFails = true;
    renderApp("/queue", fake);
    const banner = await screen.findByRole("status", {}, { timeout: 5000 });
    expect(banner.textContent).toMatch(/Estado del despacho desconocido/);
    expect(banner.querySelector('a[href="/settings"]')).not.toBeNull();
  });

  it("with cached data, an error when reading again does not hide the unknown state notice", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    expect(screen.queryByText(/Estado del despacho desconocido/)).toBeNull();
    // The read fails after having seen all providers enabled; the PUT disables two.
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Claude" }));
    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(
      () => expect(fake.providers).toEqual({ claude: false, copilot: false, codex: true }),
      {
        timeout: 5000,
      },
    );
    expect(
      await screen.findByText(/Estado del despacho desconocido/, {}, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it("disappears when enabling a provider from Settings", async () => {
    const fake = new FakeApi();
    fake.providers = { claude: false, copilot: false, codex: false };
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("status");
    await user.click(await screen.findByRole("switch", { name: "Copilot" }));
    await waitFor(() => expect(screen.queryByText(/Despacho en pausa/)).toBeNull());
  });
});

describe("navigation with Settings", () => {
  it("links Settings from the header and lets the nav scroll at narrow widths", async () => {
    renderApp("/queue", new FakeApi());
    const link = await screen.findByRole("link", { name: "Settings" });
    const nav = screen.getByRole("navigation");
    expect(nav.contains(link)).toBe(false);
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).toContain("min-w-0");
    // The padding keeps overflow-x-auto from clipping the focus ring of the links.
    expect(nav.className).toMatch(/\bpy-2\b/);
    expect(nav.className).toMatch(/\bpx-1\b/);
    expect(link.className).toContain("shrink-0");
  });
});
