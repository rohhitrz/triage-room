import assert from "node:assert/strict";
import test from "node:test";
import { FakeSwitch } from "../src/switch/fake-server.ts";
import { listRooms } from "../src/switch/rooms.ts";

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
