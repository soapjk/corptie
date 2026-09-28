export function recoveryStableJson(value) {
  if (Array.isArray(value)) return `[${value.map(recoveryStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${recoveryStableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
