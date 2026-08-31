export function providerDeliveryFailureStatus(error) {
  if (error?.code === "SESSION_BUSY") return "queued";
  if (error?.dispatchState === "not_sent") return "failed";
  if ([
    "INVALID_MESSAGE",
    "SESSION_NOT_FOUND",
    "SESSION_BINDING_NOT_FOUND",
    "PROVIDER_SESSION_UNAVAILABLE",
    "PROVIDER_CAPABILITY_UNSUPPORTED",
    "PROVIDER_NOT_FOUND"
  ].includes(error?.code)) return "failed";
  // Once dispatch begins, a transport failure may have occurred after the
  // Provider accepted the command. Never retry an ambiguous execution.
  return "delivery_unknown";
}
