// Compatibility adapter used while concrete Provider implementations are moved
// out of server bootstrap code. Product/application services depend only on the
// Agent Provider contract; protocol-specific callbacks stay at the composition root.
export class CallbackAgentProvider {
  constructor(descriptor, operations = {}) {
    this.descriptor = descriptor;
    this.operations = { ...operations };
    for (const [name, operation] of Object.entries(this.operations)) {
      if (typeof operation === "function" && typeof this[name] !== "function") {
        this[name] = (...args) => operation(...args);
      }
    }
  }

  requireOperation(name) {
    const operation = this.operations[name];
    if (typeof operation !== "function") {
      throw new Error(`Agent Provider ${this.descriptor?.id ?? "unknown"} has no ${name} operation.`);
    }
    return operation;
  }
}
