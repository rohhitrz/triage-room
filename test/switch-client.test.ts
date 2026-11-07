import assert from "node:assert/strict";
import test from "node:test";
import { SwitchClient } from "../src/switch/client.ts";
import { schemaMentionsThread } from "../src/switch/discover.ts";
import { FakeSwitch } from "../src/switch/fake-server.ts";
import { BootstrapKeyError, registerAgent } from "../src/switch/register.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function clientFor(fake: FakeSwitch, cursor: () => number, hooks?: Partial<ConstructorParameters<typeof SwitchClient>[0]>) {
  return new SwitchClient({
    baseUrl: fake.baseUrl(),
    agentId: "agt_test",
    apiKey: "agent_test_key",
    connectionId: "conn-1",
    roomId: "room_1",
    getCursor: cursor,
    onDomainEvent: async () => {},
    onGap: async () => {},
    reconnectDelayMs: 20,
    ...hooks,
  });
}

test("registration refuses the bootstrap key and sets owner_only with a registration key", async () => {
  await assert.rejects(
    () => registerAgent({ baseUrl: "http://127.0.0.1:9", registrationKey: "boot", keyKind: "bootstrap" }),
    BootstrapKeyError,
  );
  await assert.rejects(
    () => registerAgent({ baseUrl: "http://127.0.0.1:9", registrationKey: "same", bootstrapKey: "same" }),
    BootstrapKeyError,
  );

  const fake = new FakeSwitch();
  await fake.start();
  try {
    const created = await registerAgent({ baseUrl: fake.baseUrl(), registrationKey: fake.registrationKey });
    assert.equal(created.id, "agt_test");
    assert.equal(fake.agents.get("agt_test")?.addressing, "owner_only");
  } finally {
    await fake.stop();
  }
});

test("socket claims the room, fetches context, and answers a 5-minute heartbeat", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  const client = clientFor(fake, () => 0);
  try {
    await client.connect();
    const open = new URL(fake.openUrls[0], "http://127.0.0.1");
    assert.equal(open.searchParams.get("rooms"), "room_1");
    assert.equal(open.searchParams.get("scope"), "single");
    assert.equal(fake.contextCalls.length, 1);
    assert.equal(fake.contextCalls[0].body.room_id, "room_1");
    assert.equal(fake.contextCalls[0].connectionId, "conn-1");
    assert.ok(client.contextReads >= 1);

    for (let i = 0; i < 150; i += 1) fake.pingAll();
    await waitFor(() => fake.pongs.length >= 150);
    assert.equal(fake.pongs.length, 150);
    assert.equal(fake.pongs[149].cursor, 0);
  } finally {
    client.stop();
    await fake.stop();
  }
});

test("posts in thread and refuses a missing thread id", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  const client = clientFor(fake, () => 4);
  try {
    await client.discover();
    await client.connect();
    await assert.rejects(() => client.post("hello", ""), /thread_id is required/);
    assert.equal(fake.posts.length, 0);
    await client.post("Unsent draft", "thr_9");
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.posts[0].body.thread_id, "thr_9");
    assert.equal(fake.posts[0].body.body, "Unsent draft");
    assert.equal(fake.posts[0].body.room_id, "room_1", "posted into the room connect_to_room selected");
    assert.match(fake.posts[0].path, /\/ops\/post_message$/);
    assert.equal(fake.posts[0].connectionId, "conn-1");
  } finally {
    client.stop();
    await fake.stop();
  }
});

test("acks a domain sequence only after the event handler finishes", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  let cursor = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = clientFor(fake, () => cursor, {
    onDomainEvent: async (frame: DomainMessage) => {
      await gate;
      cursor = frame.id;
    },
  });
  try {
    await client.connect();
    const socket = fake.sockets[0];
    fake.send(socket, {
      event: "message",
      id: 5,
      data: {
        type: "message",
        room_id: "room_1",
        sequence: 5,
        payload: {
          addressed: true,
          sender: "owner",
          message_id: "m5",
          body: "hi",
          timestamp: 1,
          thread_id: "thr",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    fake.pingAll();
    await waitFor(() => fake.pongs.length >= 1);
    assert.equal(fake.pongs.at(-1)?.cursor, 0);
    release?.();
    await waitFor(() => cursor === 5);
    fake.pingAll();
    await waitFor(() => fake.pongs.at(-1)?.cursor === 5);
  } finally {
    client.stop();
    await fake.stop();
  }
});

test("reconnect resumes from gap.resumed_at after read_context is parsed", async () => {
  const fake = new FakeSwitch();
  fake.contextMessages = [{ message_id: "src_1", body: "Order #4821", thread_id: "thr", sender: "owner-1" }];
  await fake.start();
  let cursor = 7;
  let gaps = 0;
  let parsed = 0;
  const client = clientFor(fake, () => cursor, {
    onGap: async (frame, messages) => {
      gaps += 1;
      parsed = messages.length;
      cursor = typeof frame.resumed_at === "number" ? frame.resumed_at : cursor;
    },
  });
  try {
    await client.connect();
    const firstGen = client.generation;
    fake.send(fake.sockets[0], { type: "gap", from_sequence: 1, resumed_at: 99, reason: "retention" });
    await waitFor(() => gaps === 1);
    assert.equal(parsed, 1);
    assert.equal(cursor, 99);
    assert.equal(client.contextReads, 2);
    fake.sockets[0].close();
    await waitFor(() => fake.openUrls.length >= 2);
    const again = new URL(fake.openUrls[1], "http://127.0.0.1");
    assert.equal(again.searchParams.get("start_from"), "99");
    assert.equal(again.searchParams.get("expected_generation"), String(firstGen));
    assert.equal(again.searchParams.get("rooms"), "room_1");
  } finally {
    client.stop();
    await fake.stop();
  }
});

test("registration saves the agent key before addressing can fail", async () => {
  const fake = new FakeSwitch();
  fake.failAddressing = true;
  await fake.start();
  const saved: Array<{ id: string; api_key: string }> = [];
  try {
    await assert.rejects(
      () =>
        registerAgent({
          baseUrl: fake.baseUrl(),
          registrationKey: fake.registrationKey,
          persist: (created) => saved.push(created),
        }),
      /update_agent_detail/,
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.id, "agt_test");
    assert.ok(saved[0]?.api_key);
  } finally {
    await fake.stop();
  }
});

test("a server that refuses agent-set addressing keeps its owner-only default", async () => {
  const fake = new FakeSwitch();
  fake.refuseAddressing = true;
  await fake.start();
  try {
    const created = await registerAgent({ baseUrl: fake.baseUrl(), registrationKey: fake.registrationKey });
    assert.equal(created.id, "agt_test");
    assert.equal(created.addressing, "server_default");
  } finally {
    await fake.stop();
  }
});

test("a closed eviction does not reconnect", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  const client = clientFor(fake, () => 0);
  try {
    await client.connect();
    fake.send(fake.sockets[0], { type: "evicted", code: "closed", reason: "agent deleted" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(client.fatal, "closed");
    assert.equal(fake.openUrls.length, 1);
  } finally {
    client.stop();
    await fake.stop();
  }
});

test("thread_id must be a schema field, not only a word in the description", () => {
  assert.equal(schemaMentionsThread({ description: "posts use thread_id" }), false);
  assert.equal(schemaMentionsThread({ properties: { thread_id: { type: "string" } } }), true);
  assert.equal(schemaMentionsThread({ allOf: [{ required: ["thread_id"] }] }), true);
});

test("discovery records the server version and refuses a schema without thread_id", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  try {
    const client = clientFor(fake, () => 0);
    const found = await client.discover();
    assert.equal(found.server_version, "test-server-0.31.0");
    assert.equal(found.health_status, 200);
    client.stop();

    fake.omitThreadInSchema = true;
    const bare = clientFor(fake, () => 0);
    await assert.rejects(() => bare.discover(), /thread_id/);
  } finally {
    await fake.stop();
  }
});
