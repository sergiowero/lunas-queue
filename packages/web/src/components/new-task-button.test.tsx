import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render.tsx";
import { buttonVariants } from "./ui/button.tsx";

const PAGES = ["/queue", "/inbox", "/projects", "/tasks/new"];

async function newTaskButton() {
  return screen.findByRole("link", { name: "Nueva tarea" });
}

describe("botón Nueva tarea del header", () => {
  it.each(PAGES)("en %s, el nav de pestañas no contiene Nueva tarea", async (path) => {
    renderApp(path);
    await newTaskButton();
    const nav = within(screen.getByRole("navigation"));
    expect(nav.queryByText("Nueva tarea")).toBeNull();
    for (const link of nav.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toBe("/tasks/new");
    }
  });

  it.each(PAGES)(
    "en %s, es el único enlace «Nueva tarea», fuera del nav, con texto visible y un + decorativo",
    async (path) => {
      renderApp(path);
      const link = await newTaskButton();
      expect(screen.getAllByRole("link", { name: "Nueva tarea" })).toHaveLength(1);
      expect(link.getAttribute("href")).toBe("/tasks/new");
      expect(screen.getByRole("navigation").contains(link)).toBe(false);
      expect(link.textContent).toBe("Nueva tarea");
      const svg = link.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.dataset.icon).toBe("plus");
    },
  );

  it("queda justo antes de Settings y del selector de tema, y empuja las acciones a la derecha", async () => {
    renderApp("/queue");
    const button = await newTaskButton();
    const settings = await screen.findByRole("link", { name: "Settings" });
    const theme = await screen.findByRole("button", { name: /^Cambiar a tema/ });
    expect(button.nextElementSibling).toBe(settings);
    expect(settings.nextElementSibling).toBe(theme);
    expect(theme.parentElement?.lastElementChild).toBe(theme);
    expect(button.parentElement).toBe(theme.parentElement);
    expect(button.className).toContain("ml-auto");
    expect(button.className).toContain("shrink-0");
    expect(settings.className).not.toContain("ml-auto");
  });

  it("usa el estilo de botón primario pequeño del sistema de diseño", async () => {
    renderApp("/queue");
    const button = await newTaskButton();
    for (const cls of buttonVariants({ size: "sm" }).split(" ")) {
      expect(button.className).toContain(cls);
    }
  });

  it("un click desde /queue abre la página Nueva tarea existente", async () => {
    const { user, router } = renderApp("/queue");
    await user.click(await newTaskButton());
    expect(router.state.location.pathname).toBe("/tasks/new");
    expect(await screen.findByLabelText("Proyecto")).toBeTruthy();
    expect(screen.getByLabelText("Intent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear tarea" })).toBeTruthy();
  });
});
