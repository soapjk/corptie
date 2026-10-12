import { deviceError } from "./clientDeviceAuthority.mjs";

/** Called with a server-authenticated identity, never request body fields.
 * Keep historical device keys intact; local users occupy a distinct namespace
 * in the existing receipt journal rather than impersonating a paired device.
 */
export function clientCommandPrincipalKey(identity) {
  if (identity?.kind === "local_user") {
    if (typeof identity.principalId !== "string" || !identity.principalId || identity.principalId.length > 512) {
      throw deviceError("LOCAL_USER_REQUIRED", 403);
    }
    return `local-user:${identity.principalId}`;
  }
  if (typeof identity?.deviceId !== "string" || !identity.deviceId || identity.deviceId.length > 512
      || identity.deviceId.startsWith("local-user:")) throw deviceError("INVALID_CREDENTIAL", 401);
  return identity.deviceId;
}
