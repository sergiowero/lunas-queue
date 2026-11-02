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
      { method: "PUT", path: "/api/settings/providers", body: { claude: false } },
    ]);
    expect(fake.providers).toEqual({ claude: false, copilot: true });

    // Recargar: una app nueva contra el mismo estado guardado.
    unmount();
    renderApp("/settings", fake);
    expect(on(await screen.findByRole("switch", { name: "Claude" }))).toBe(false);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
  });

  it("con teclado, el interruptor guardando sigue enfocable y no se pulsa dos veces", async () => {
    const fake = new FakeApi();
    let release = () => {};
    fake.holdProvidersPut = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderApp("/settings", fake);
    const claude = await screen.findByRole("switch", { name: "Claude" });
    claude.focus();

    await user.keyboard(" ");

    // En vuelo: aria-disabled y no `disabled`, que sacaría al botón del orden de tabulación y
    // soltaría el foco al terminar.
    await waitFor(() => expect(claude.getAttribute("aria-disabled")).toBe("true"));
    expect(claude.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(claude);
    await user.keyboard(" ");
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);

    release();
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    await waitFor(() => expect(claude.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(claude);
    expect(fake.providers).toEqual({ claude: false, copilot: true });
  });

  it("un cambio de otra pestaña no se pisa: cada interruptor envía solo su proveedor", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    // Otra pestaña apaga Claude mientras esta conserva la vista vieja (Claude encendido).
    fake.providers = { claude: false, copilot: true };

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    expect(fake.providers).toEqual({ claude: false, copilot: false });
    expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false);
  });

  it("la respuesta de un PUT viejo no restaura una vista anterior a un cambio posterior", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    // Otra pestaña apaga Claude justo después de que este PUT se guarda y antes de que responda.
    fake.afterProvidersPut = () => {
      fake.providers = { ...fake.providers, claude: false };
    };

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
  });

  it("un error al volver a leer conserva los interruptores con el último estado y avisa", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    // El PUT se guardó: el aviso lo dice y no habla de un cambio fallido (ver el test siguiente).
    const alert = await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });
    expect(alert.getAttribute("role")).toBe("alert");
    // Los interruptores conservan el último estado leído: ambos siguen encendidos.
    expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(true);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(true);
  });

  it("una lectura fallida posterior a una relectura exitosa no dice que el cambio no se leyó", async () => {
    const fake = new FakeApi();
    const { user, refresh } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;
    await user.click(screen.getByRole("switch", { name: "Copilot" }));
    await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });

    // Una lectura posterior al PUT tiene éxito: los interruptores ya reflejan lo guardado.
    fake.providersReadFails = false;
    await refresh();
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false));
    expect(screen.queryByText(/El cambio se guardó/)).toBeNull();

    // Otra lectura falla después: es un fallo ajeno al cambio, con el texto genérico.
    fake.providersReadFails = true;
    await refresh();
    const alert = await screen.findByText(/No se pudo actualizar la configuración/);
    expect(alert.textContent).not.toMatch(/El cambio se guardó/);
    expect(on(screen.getByRole("switch", { name: "Copilot" }))).toBe(false);
  });

  it("si el PUT se guarda pero la relectura falla, avisa que el cambio se guardó y no que falló", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    const alert = await screen.findByText(/El cambio se guardó/, {}, { timeout: 4000 });
    expect(alert.textContent).toMatch(/no se pudo leer el estado/);
    expect(alert.textContent).not.toMatch(/No se pudo actualizar la configuración/);
    expect(fake.providers).toEqual({ claude: true, copilot: false });
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

describe("sección Concurrencia", () => {
  const field = () => screen.findByRole("spinbutton", { name: /Agentes concurrentes/ });

  it("muestra el límite vigente en un campo numérico con su botón Guardar", async () => {
    renderApp("/settings");
    expect((await field()).getAttribute("type")).toBe("number");
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
    expect(screen.getByRole("heading", { name: "Concurrencia" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeTruthy();
  });

  it("escribir 3 y guardar envía el PUT, muestra 3 tras releer y deshabilita Guardar mientras guarda", async () => {
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

  it("sobrevive a recargar: una app nueva lee el límite guardado", async () => {
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

  it("el mensaje de validación desaparece al corregir el valor y guardar", async () => {
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

  it("si falla el guardado muestra un aviso, conserva el último valor leído y los proveedores siguen", async () => {
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
    // Los proveedores siguen funcionando.
    await user.click(screen.getByRole("switch", { name: "Claude" }));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
    expect(fake.providers).toEqual({ claude: false, copilot: true });
  });

  it("si el PUT se guarda pero la relectura falla, el campo muestra el valor guardado y el aviso dice que se guardó", async () => {
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

  it("si un guardado falla después de uno que se guardó sin releerse, el aviso indica el valor guardado", async () => {
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

  it("si falla la lectura muestra un aviso y la sección de proveedores sigue funcionando", async () => {
    const fake = new FakeApi();
    fake.concurrencyReadFails = true;
    const { user } = renderApp("/settings", fake);

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("sin conexión");
    await user.click(await screen.findByRole("switch", { name: "Claude" }));
    await waitFor(() => expect(on(screen.getByRole("switch", { name: "Claude" }))).toBe(false));
  });

  it("si falla una relectura conserva el último valor leído y avisa", async () => {
    const fake = new FakeApi();
    const { refresh } = renderApp("/settings", fake);
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
    fake.concurrencyReadFails = true;

    await refresh();

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("sin conexión");
    expect((await field()) as HTMLInputElement).toHaveProperty("value", "5");
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

  it("avisa que el estado es desconocido si la configuración no se puede leer", async () => {
    const fake = new FakeApi();
    fake.providersReadFails = true;
    renderApp("/queue", fake);
    const banner = await screen.findByRole("status", {}, { timeout: 5000 });
    expect(banner.textContent).toMatch(/Estado del despacho desconocido/);
    expect(banner.querySelector('a[href="/settings"]')).not.toBeNull();
  });

  it("con datos en caché, un error al volver a leer no oculta el aviso de estado desconocido", async () => {
    const fake = new FakeApi();
    const { user } = renderApp("/settings", fake);
    await screen.findByRole("switch", { name: "Claude" });
    expect(screen.queryByText(/Estado del despacho desconocido/)).toBeNull();
    // La lectura falla después de haber visto ambos proveedores habilitados; el PUT los deshabilita.
    fake.providersReadFails = true;

    await user.click(screen.getByRole("switch", { name: "Claude" }));
    await user.click(screen.getByRole("switch", { name: "Copilot" }));

    await waitFor(() => expect(fake.providers).toEqual({ claude: false, copilot: false }), {
      timeout: 5000,
    });
    expect(
      await screen.findByText(/Estado del despacho desconocido/, {}, { timeout: 5000 }),
    ).toBeTruthy();
  });

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
  it("enlaza Settings desde el header y deja desplazar el nav en anchos estrechos", async () => {
    renderApp("/queue", new FakeApi());
    const link = await screen.findByRole("link", { name: "Settings" });
    const nav = screen.getByRole("navigation");
    expect(nav.contains(link)).toBe(false);
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).toContain("min-w-0");
    // El relleno evita que overflow-x-auto recorte el anillo de foco de los enlaces.
    expect(nav.className).toMatch(/\bpy-2\b/);
    expect(nav.className).toMatch(/\bpx-1\b/);
    expect(link.className).toContain("shrink-0");
  });
});
