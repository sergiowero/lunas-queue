import { herdrContract } from "./contract.ts";
import { FakeHerdr } from "./fake.ts";

herdrContract("fake en memoria", async () => {
  const adapter = new FakeHerdr();
  let repos = 0;
  return {
    adapter,
    newRepo: async () => `/repos/r${++repos}`,
    worktreePath: (name) => `/worktrees/${name}`,
    agentKind: "claude",
    agentEnv: {},
    dropStreams: () => adapter.dropStreams(),
    cleanup: async () => {},
  };
});
