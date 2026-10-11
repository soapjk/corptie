import { readFileSync } from "node:fs";
import Ajv from "ajv";
export const detailV2Schema = JSON.parse(readFileSync(new URL("../contracts/detail-v2.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false }); ajv.addSchema(detailV2Schema);
const validators = Object.fromEntries(["State", "Commit", "Request"].map(kind =>
  [kind, ajv.compile({ $ref: `${detailV2Schema.$id}#/definitions/${kind}` })]));
export function validateDetailV2Envelope(value, kind) {
  if (!validators[kind]?.(value)) throw Object.assign(new Error("DETAIL_V2_CONTRACT"), { code: "DETAIL_V2_CONTRACT", status: 400 });
  return value;
}
