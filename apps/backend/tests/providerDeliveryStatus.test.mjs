import assert from "node:assert/strict";
import test from "node:test";
import { providerDeliveryFailureStatus } from "../src/application/providerDeliveryStatus.mjs";

test("pre-dispatch failures are terminal deliveries and can be retried safely", () => {
  assert.equal(providerDeliveryFailureStatus({
    code: "SESSION_TOOL_CATALOG_REFRESH_FAILED",
    dispatchState: "not_sent"
  }), "failed");
});

test("busy work remains queued even when dispatch has not started", () => {
  assert.equal(providerDeliveryFailureStatus({
    code: "SESSION_BUSY",
    dispatchState: "not_sent"
  }), "queued");
});

test("known validation and binding failures are terminal", () => {
  for (const code of [
    "INVALID_MESSAGE",
    "SESSION_NOT_FOUND",
    "SESSION_BINDING_NOT_FOUND",
    "PROVIDER_SESSION_UNAVAILABLE",
    "PROVIDER_CAPABILITY_UNSUPPORTED",
    "PROVIDER_NOT_FOUND"
  ]) {
    assert.equal(providerDeliveryFailureStatus({ code }), "failed", code);
  }
});

test("transport failures after dispatch remain delivery unknown", () => {
  assert.equal(providerDeliveryFailureStatus({ code: "PROVIDER_TRANSPORT_CLOSED" }), "delivery_unknown");
});
