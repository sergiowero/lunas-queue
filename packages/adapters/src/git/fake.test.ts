import { gitContract } from "./contract.ts";
import { FakeGit, type FakeTree } from "./fake.ts";

gitContract("fake en memoria", async () => {
  const adapter = new FakeGit();
  let repos = 0;
  return {
    adapter,
    newRepo: async (files: FakeTree) => {
      const cwd = `/repo${++repos}`;
      adapter.addCheckout(cwd, { branch: "main", tree: files });
      return cwd;
    },
    pushToRemote: async (cwd, files) => {
      adapter.pushToRemote(cwd, "main", files);
    },
    writeWorkingFile: async (cwd, path) => adapter.writeWorkingFile(cwd, path),
    freePath: async () => `/tmp-worktrees/w${++repos}`,
    headMessage: async (cwd) => adapter.headMessage(cwd),
    trackedFiles: async (cwd) => adapter.trackedFiles(cwd),
    cleanup: async () => {},
  };
});
