import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { FakeSwitch } from "../src/switch/fake-server.ts";
import { listRooms } from "../src/switch/rooms.ts";

test("rooms CLI sends the agent key as a bearer token", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/rooms-cli.ts"], {
      env: {
        ...process.env,
        SWITCH_BASE_URL: fake.baseUrl(),
        SWITCH_AGENT_ID: "agt_test",
        SWITCH_AGENT_KEY: "agent_test_key",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (status) => resolve(status ?? 1));
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /room_1/);
    assert.ok(fake.auths.includes("Bearer agent_test_key"));
    assert.equal(fake.auths.includes("Bearer undefined"), false);
  } finally {
    await fake.stop();
  }
});

test("list_rooms returns the room id the README tells Rohit to copy", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  try {
    const body = (await listRooms({
      baseUrl: fake.baseUrl(),
      agentId: "agt_test",
      apiKey: "agent_test_key",
    })) as { result: Array<{ id: string }> };
    assert.equal(body.result[0].id, "room_1");
  } finally {
    await fake.stop();
  }
});
