import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render.tsx";
import { buttonVariants } from "./ui/button.tsx";

const PAGES = ["/queue", "/inbox", "/projects", "/tasks/new"];

async function newTaskButton() {
  return screen.findByRole("link", { name: "Nueva tarea" });
}

describe("header New task button", () => {
  it.each(PAGES)("on %s, the tab nav does not contain Nueva tarea", async (path) => {
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

  it("sits right before Settings and the theme toggle, and pushes the actions to the right", async () => {
    renderApp("/queue");
    const button = await newTaskButton();
    const settings = await screen.findByRole("link", { name: "Settings" });
    const language = await screen.findByRole("button", { name: "Cambiar a inglés" });
    const theme = await screen.findByRole("button", { name: /^Cambiar a tema/ });
    expect(button.nextElementSibling).toBe(settings);
    expect(settings.nextElementSibling).toBe(language);
    expect(language.nextElementSibling).toBe(theme);
    expect(theme.parentElement?.lastElementChild).toBe(theme);
    expect(button.parentElement).toBe(theme.parentElement);
    expect(button.className).toContain("ml-auto");
    expect(button.className).toContain("shrink-0");
    expect(settings.className).not.toContain("ml-auto");
  });

  it("uses the system's small primary button style", async () => {
    renderApp("/queue");
    const button = await newTaskButton();
    for (const cls of buttonVariants({ size: "sm" }).split(" ")) {
      expect(button.className).toContain(cls);
    }
  });

  it("on mobile the header does not overflow: the wordmark hides below sm and the brand keeps its name", async () => {
    renderApp("/queue");
    await newTaskButton();
    const brand = screen.getByRole("link", { name: "LunasQ" });
    expect(brand.getAttribute("href")).toBe("/queue");
    const wordmark = within(brand).getByText("LunasQ");
    expect(wordmark.className).toContain("hidden");
    expect(wordmark.className).toContain("sm:inline");
    expect(brand.parentElement?.className).toContain("px-4");
    expect(brand.parentElement?.className).toContain("sm:px-6");
  });

  it("a click from /queue opens the existing New task page", async () => {
    const { user, router } = renderApp("/queue");
    await user.click(await newTaskButton());
    expect(router.state.location.pathname).toBe("/tasks/new");
    expect(await screen.findByLabelText("Proyecto")).toBeTruthy();
    expect(screen.getByLabelText("Intent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear tarea" })).toBeTruthy();
  });
});
