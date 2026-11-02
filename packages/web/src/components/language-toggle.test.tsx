import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { formatCost, formatDate } from "../lib/format.ts";
import { LANGUAGE_KEY } from "../lib/i18n.ts";

const html = document.documentElement;

function toggle(name: string) {
  return screen.findByRole("button", { name });
}

describe("language toggle", () => {
  it("without a stored preference the UI is Spanish and the button says ES with the flag of Mexico", async () => {
    renderApp("/queue");
    const button = await toggle("Cambiar a inglés");
    expect(html.lang).toBe("es");
    expect(button.textContent).toBe("ES");
    expect(button.querySelector("svg")?.dataset.flag).toBe("mx");
    expect(screen.getByRole("heading", { name: "Cola global" })).toBeTruthy();
  });

  it("clicking switches every text to English, says EN with the US flag and stores en", async () => {
    const { user } = renderApp("/queue");
    await user.click(await toggle("Cambiar a inglés"));
    const button = await toggle("Switch to Spanish");
    expect(html.lang).toBe("en");
    expect(button.textContent).toBe("EN");
    expect(button.querySelector("svg")?.dataset.flag).toBe("us");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect(screen.getByRole("heading", { name: "Global queue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New task" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inbox" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Switch to (dark|light) theme$/ })).toBeTruthy();
  });

  it("clicking again returns to Spanish and stores es", async () => {
    const { user } = renderApp("/queue");
    await user.click(await toggle("Cambiar a inglés"));
    await user.click(await toggle("Switch to Spanish"));
    const button = await toggle("Cambiar a inglés");
    expect(html.lang).toBe("es");
    expect(button.textContent).toBe("ES");
    expect(button.querySelector("svg")?.dataset.flag).toBe("mx");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("es");
    expect(screen.getByRole("heading", { name: "Cola global" })).toBeTruthy();
  });

  it("with en stored the UI starts in English", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    renderApp("/queue");
    expect(await toggle("Switch to Spanish")).toBeTruthy();
    expect(html.lang).toBe("en");
    expect(screen.getByRole("heading", { name: "Global queue" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Cola global" })).toBeNull();
  });

  it("an invalid stored value keeps Spanish", async () => {
    localStorage.setItem(LANGUAGE_KEY, "fr");
    renderApp("/queue");
    expect(await toggle("Cambiar a inglés")).toBeTruthy();
    expect(html.lang).toBe("es");
  });

  it("a localStorage that throws does not break the UI and the switch works for the session", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      clear: () => {},
    });
    const { user } = renderApp("/queue");
    await user.click(await toggle("Cambiar a inglés"));
    expect(await toggle("Switch to Spanish")).toBeTruthy();
    expect(html.lang).toBe("en");
  });

  it("is a button next to the theme toggle, in the right-hand group, with decorative outline flags", async () => {
    renderApp("/queue");
    const button = await toggle("Cambiar a inglés");
    const theme = await screen.findByRole("button", { name: /^Cambiar a tema/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.nextElementSibling).toBe(theme);
    expect(button.parentElement).toBe(theme.parentElement);
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("button")).toContain(button);
    const flag = button.querySelector("svg");
    expect(flag?.getAttribute("aria-hidden")).toBe("true");
    expect(flag?.getAttribute("fill")).toBe("none");
    expect(flag?.getAttribute("stroke")).toBe("currentColor");
    expect(flag?.querySelectorAll("[fill]:not([fill=none])")).toHaveLength(0);
  });

  it("the aria-label describes the action in the current language", async () => {
    const { user } = renderApp("/queue");
    expect((await toggle("Cambiar a inglés")).getAttribute("aria-label")).toBe("Cambiar a inglés");
    await user.click(await toggle("Cambiar a inglés"));
    expect((await toggle("Switch to Spanish")).getAttribute("aria-label")).toBe(
      "Switch to Spanish",
    );
  });
});

describe("API errors in the UI", () => {
  async function failFocus(code: string, message: string, language: "es" | "en") {
    if (language === "en") localStorage.setItem(LANGUAGE_KEY, "en");
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id);
    const run = fake.startRun(task.id, "implement");
    fake.focusError = { status: 409, error: code, message };
    const app = renderApp(`/tasks/${task.id}`, fake);
    await app.user.click(
      await screen.findByRole("button", { name: new RegExp(run.herdrPane ?? "") }),
    );
  }

  it("a known code is shown with the Spanish dictionary text", async () => {
    await failFocus("agent_gone", "t1 is no longer in herdr", "es");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("El agente ya no está en herdr."),
    );
  });

  it("an unknown code shows the English message of the API", async () => {
    await failFocus("something_new", "Something new went wrong", "es");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Something new went wrong"),
    );
  });
});

describe("regional formatting", () => {
  it("dates use the locale of the effective language", () => {
    const iso = "2026-03-14T15:09:26Z";
    document.documentElement.lang = "es";
    const spanish = formatDate(iso);
    document.documentElement.lang = "en";
    const english = formatDate(iso);
    expect(spanish).toBe(
      new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "medium" }).format(
        new Date(iso),
      ),
    );
    expect(english).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "medium" }).format(
        new Date(iso),
      ),
    );
    expect(spanish).not.toBe(english);
  });

  it("costs use the locale of the effective language", () => {
    document.documentElement.lang = "es";
    const spanish = formatCost(1234.5);
    document.documentElement.lang = "en";
    const english = formatCost(1234.5);
    expect(english).toBe("$1,234.50");
    expect(spanish).toBe(
      `$${new Intl.NumberFormat("es", { minimumFractionDigits: 2 }).format(1234.5)}`,
    );
    expect(spanish).not.toBe(english);
    expect(formatCost(null)).toBe("—");
  });
});

describe("language-dependent table cells follow a language switch", () => {
  it("the phase of a Run is translated after the switch", async () => {
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id);
    fake.startRun(task.id, "implement");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const runsCell = async (name: string) => {
      const runs = await screen.findByRole("region", { name: "Runs" });
      return within(runs).queryByRole("cell", { name });
    };
    await waitFor(async () => expect(await runsCell("Implementación")).toBeTruthy());
    await user.click(await toggle("Cambiar a inglés"));
    await waitFor(async () => expect(await runsCell("Implementation")).toBeTruthy());
    expect(await runsCell("Implementación")).toBeNull();
  });

  it("the result type of a completed task without a PR is translated after the switch", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, {
      intent: "Hecha",
      state: "completed",
      subState: null,
      resultKind: "research",
    });
    const { user } = renderApp("/completed", fake);
    const row = await screen.findByRole("row", { name: /Hecha/ });
    const before = within(row).getAllByRole("cell")[3]?.textContent;
    await user.click(await toggle("Cambiar a inglés"));
    const after = within(await screen.findByRole("row", { name: /Hecha/ })).getAllByRole("cell")[3]
      ?.textContent;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("the New task labels Intent and Tags come from the dictionary", async () => {
    const { user } = renderApp("/tasks/new");
    expect(await screen.findByLabelText("Intención")).toBeTruthy();
    expect(screen.getByLabelText("Etiquetas")).toBeTruthy();
    await user.click(await toggle("Cambiar a inglés"));
    expect(await screen.findByLabelText("Intent")).toBeTruthy();
    expect(screen.getByLabelText("Tags")).toBeTruthy();
  });
});
