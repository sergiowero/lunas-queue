import { describe, expect, it } from "vitest";
import type { GhExecFn, GhExecOptions, GhExecResult } from "./cli.ts";
import { RealGitHub } from "./real.ts";
import { PR_FIELDS } from "./wire.ts";

const url = "https://github.com/o/r/pull/3";
const ghPr = (state = "OPEN") => ({
  number: 3,
  url,
  state,
  isDraft: false,
  headRefName: "lunasq/t1",
  baseRefName: "main",
  mergedAt: null,
  closedAt: null,
  statusCheckRollup: [],
  reviewDecision: "",
  reviews: [],
  labels: [],
});

/** Fake exec that answers by subcommand (`pr list`, `pr create`, `pr view`). */
function scripted(responses: Record<string, Partial<GhExecResult>[]>) {
  const calls: { args: string[]; opts: GhExecOptions }[] = [];
  const exec: GhExecFn = async (_file, args, opts) => {
    calls.push({ args, opts });
    const key = args.slice(0, 2).join(" ");
    const next = responses[key]?.shift();
    if (!next) throw new Error(`no response for ${key}`);
    return { stdout: "", stderr: "", exitCode: 0, ...next };
  };
  return { exec, calls };
}

const input = {
  cwd: "/wt/t1",
  head: "lunasq/t1",
  base: "main",
  title: "-t: título con $(comillas) 'raras'",
  body: "## Intent\nalgo",
};

describe("RealGitHub", () => {
  it("createPr opens the PR with the body via stdin and returns it read back from GitHub", async () => {
    const { exec, calls } = scripted({
      "pr list": [{ stdout: "[]" }],
      "pr create": [{ stdout: `Creating pull request...\n${url}\n` }],
      "pr view": [{ stdout: JSON.stringify(ghPr()) }],
    });
    const { pr, created } = await new RealGitHub({ exec }).createPr({ ...input, draft: true });
    expect(created).toBe(true);
    expect(pr).toMatchObject({ number: 3, url, state: "open", headBranch: "lunasq/t1" });
    expect(calls.map((c) => c.args)).toEqual([
      [
        "pr",
        "list",
        "--head=lunasq/t1",
        "--base=main",
        "--state=open",
        `--json=${PR_FIELDS}`,
        "--limit=1",
      ],
      [
        "pr",
        "create",
        "--head=lunasq/t1",
        "--base=main",
        `--title=${input.title}`,
        "--body-file=-",
        "--draft",
      ],
      ["pr", "view", url, `--json=${PR_FIELDS}`],
    ]);
    expect(calls[0]?.opts.cwd).toBe("/wt/t1");
    expect(calls[1]?.opts).toMatchObject({ cwd: "/wt/t1", input: input.body });
  });

  it("createPr returns the already open PR without creating another", async () => {
    const { exec, calls } = scripted({ "pr list": [{ stdout: JSON.stringify([ghPr()]) }] });
    const { pr, created } = await new RealGitHub({ exec }).createPr(input);
    expect(created).toBe(false);
    expect(pr.url).toBe(url);
    expect(calls).toHaveLength(1);
  });

  it("createPr that loses the race against another process returns the other's PR", async () => {
    const { exec } = scripted({
      "pr list": [{ stdout: "[]" }, { stdout: JSON.stringify([ghPr()]) }],
      "pr create": [
        {
          exitCode: 1,
          stderr: `a pull request for branch "lunasq/t1" into branch "main" already exists:\n${url}`,
        },
      ],
    });
    expect(await new RealGitHub({ exec }).createPr(input)).toMatchObject({
      created: false,
      pr: { url },
    });
  });

  it("createPr propagates the other gh failures", async () => {
    const { exec } = scripted({
      "pr list": [{ stdout: "[]" }],
      "pr create": [{ exitCode: 1, stderr: "pull request create failed: head branch not pushed" }],
    });
    await expect(new RealGitHub({ exec }).createPr(input)).rejects.toMatchObject({
      code: "gh_failed",
    });
  });

  it("getPr reads the PR by URL without cwd and translates not_found", async () => {
    const { exec, calls } = scripted({
      "pr view": [
        { stdout: JSON.stringify(ghPr("MERGED")) },
        {
          exitCode: 1,
          stderr: "GraphQL: Could not resolve to a PullRequest with the number of 9.",
        },
      ],
    });
    const gh = new RealGitHub({ exec });
    expect((await gh.getPr(url)).state).toBe("merged");
    expect(calls[0]?.opts.cwd).toBeUndefined();
    await expect(gh.getPr("https://github.com/o/r/pull/9")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("addLabels creates each label, sets it on the PR and returns the PR read back", async () => {
    const { exec, calls } = scripted({
      "label create": [{}, {}],
      "pr edit": [{}],
      "pr view": [
        { stdout: JSON.stringify({ ...ghPr(), labels: [{ name: "lunasq:risk-high" }] }) },
      ],
    });
    const pr = await new RealGitHub({ exec }).addLabels({
      cwd: "/wt/t1",
      url,
      labels: [
        { name: "lunasq:risk-high", color: "b60205", description: "High risk" },
        { name: "-rara" },
      ],
    });
    expect(pr.labels).toEqual(["lunasq:risk-high"]);
    expect(calls.map((c) => c.args)).toEqual([
      [
        "label",
        "create",
        "lunasq:risk-high",
        "--force",
        "--color=b60205",
        "--description=High risk",
      ],
      ["label", "create", "-rara", "--force"],
      ["pr", "edit", url, "--add-label=lunasq:risk-high", "--add-label=-rara"],
      ["pr", "view", url, `--json=${PR_FIELDS}`],
    ]);
    expect(calls.slice(0, 3).every((c) => c.opts.cwd === "/wt/t1")).toBe(true);
  });

  it("addLabels rejects what is not a PR URL without calling gh", async () => {
    const { exec, calls } = scripted({});
    await expect(
      new RealGitHub({ exec }).addLabels({ cwd: "/wt/t1", url: "12", labels: [{ name: "x" }] }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toEqual([]);
  });

  it("createPr without a URL in the output fails without calling pr view", async () => {
    const { exec, calls } = scripted({
      "pr list": [{ stdout: "[]" }],
      "pr create": [{ stdout: "\n" }],
    });
    await expect(new RealGitHub({ exec }).createPr(input)).rejects.toMatchObject({
      code: "invalid_output",
    });
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["pr list", "pr create"]);
  });

  it("getPr rejects what is not a PR URL without calling gh", async () => {
    const { exec, calls } = scripted({});
    const gh = new RealGitHub({ exec });
    for (const ref of ["", "12", "lunasq/t1"]) {
      await expect(gh.getPr(ref)).rejects.toMatchObject({ code: "not_found" });
    }
    expect(calls).toEqual([]);
  });

  it("findOpenPr returns null without an open PR", async () => {
    const { exec } = scripted({ "pr list": [{ stdout: "[]" }] });
    expect(await new RealGitHub({ exec }).findOpenPr(input)).toBeNull();
  });
});
