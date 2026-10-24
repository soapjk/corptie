/** Remove only Git's final record terminator, preserving path whitespace. */
export function gitScalarOutput(value) {
  return String(value ?? "").replace(/\r?\n$/, "");
}
