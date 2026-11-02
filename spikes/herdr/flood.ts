// Spike: generates N workspace.metadata_updated events via workspace.report_metadata to cause backpressure.
// The socket serves one request per connection, so it opens one connection per request (in groups of `batch`).
import { createConnection } from "node:net";

const [socketPath, target = "w1", n = "5000", batch = "50"] = process.argv.slice(2);

function request(i: number): Promise<void> {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath!);
    const req = {
      id: `f${i}`,
      method: "workspace.report_metadata",
      params: { workspace_id: target, source, tokens: { n: String(i) }, seq: i + 1 },
    };
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", () => sock.end());
    sock.on("close", () => resolve());
    sock.on("error", () => resolve());
  });
}

// herdr discards updates whose seq does not exceed the last one seen per source: a unique source per run.
const source = `flood-${Date.now()}`;
const t0 = Date.now();
for (let i = 0; i < Number(n); i += Number(batch)) {
  await Promise.all(Array.from({ length: Math.min(Number(batch), Number(n) - i) }, (_, k) => request(i + k)));
}
console.log(`${n} requests en ${Date.now() - t0} ms`);
