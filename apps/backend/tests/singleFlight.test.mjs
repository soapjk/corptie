import assert from "node:assert/strict";
import test from "node:test";
import { SingleFlight } from "../src/utils/singleFlight.mjs";

test("single flight shares one concurrent operation per key", async () => {
  const flights = new SingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await gate;
    return "snapshot";
  };

  const first = flights.run("session-a", operation);
  const second = flights.run("session-a", operation);
  await Promise.resolve();

  assert.equal(calls, 1);
  assert.equal(flights.size, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["snapshot", "snapshot"]);
  assert.equal(flights.size, 0);
});

test("single flight retries after a failed operation settles", async () => {
  const flights = new SingleFlight();
  let calls = 0;

  await assert.rejects(flights.run("session-a", async () => {
    calls += 1;
    throw new Error("provider unavailable");
  }), /provider unavailable/);

  assert.equal(await flights.run("session-a", async () => {
    calls += 1;
    return "recovered";
  }), "recovered");
  assert.equal(calls, 2);
  assert.equal(flights.size, 0);
});

test("single flight keeps different Session keys independent", async () => {
  const flights = new SingleFlight();
  const results = await Promise.all([
    flights.run("session-a", async () => "a"),
    flights.run("session-b", async () => "b")
  ]);

  assert.deepEqual(results, ["a", "b"]);
});
