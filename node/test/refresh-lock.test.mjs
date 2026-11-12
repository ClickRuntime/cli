// Parallel token reads refresh once: the credentials lock keeps two refreshes with one refresh
// token from reaching the server (which would treat the second as reuse and end the sign-in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parallel accessToken calls refresh once", async () => {
  let refreshes = 0;
  const server = createServer((req, res) => {
    refreshes++;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: `at-${refreshes}`, refresh_token: `rt-${refreshes}`, expires_in: 3600 }));
    }, 50);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "crcli-"));
  process.env.CLICKRUNTIME_CONFIG_DIR = dir;
  process.env.CLICKRUNTIME_AUTH_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.CLICKRUNTIME_TOKEN;
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ profiles: { default: { access_token: "old", refresh_token: "rt-0", expires_at: 1 } } }));
  try {
    const { accessToken } = await import("../dist/client.js");
    const tokens = await Promise.all(Array.from({ length: 5 }, () => accessToken("default").then((t) => t.token)));
    assert.equal(refreshes, 1);
    assert.deepEqual(new Set(tokens), new Set(["at-1"]));
    assert.equal(existsSync(join(dir, "credentials.lock")), false);
  } finally {
    server.close();
  }
});
