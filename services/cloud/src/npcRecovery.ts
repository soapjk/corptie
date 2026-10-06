/** Operations-only policy. A live process is not proof of a working tunnel. */
export type NPCSignal = "auth-rejected" | "transport-closed" | "connected" | "other";
export function classifyNPCOutput(line: string): NPCSignal {
  // Never return raw NPC output: upstream errors can contain vkeys/passwords.
  if (/Validation key .* incorrect/i.test(line)) return "auth-rejected";
  if (/Successful connection with server/i.test(line)) return "connected";
  if (/\bEOF\b|close mux|connection server failed/i.test(line)) return "transport-closed";
  return "other";
}

export interface NPCHealth {
  localReady: boolean;
  publicReady: boolean;
  bridgeReachable: boolean;
  childAlive: boolean;
}
export interface NPCDecision {
  action: "wait" | "restart";
  reason: "healthy" | "local-unavailable" | "bridge-unreachable" | "observing" |
    "upstream-investigation" | "cooldown" | "restart-budget-exhausted" | "authentication-stuck" |
    "transport-stuck" | "process-exited";
}

export class NPCRecoveryPolicy {
  private authFailures = 0;
  private transportFailures = 0;
  private healthFailures = 0;
  private healthySince: number | null = null;
  private restartTimes: number[];
  constructor(restartTimes: number[] = []) {
    if (restartTimes.length > 3 || !restartTimes.every((time, index) => Number.isSafeInteger(time) && time >= 0 &&
        (index === 0 || time >= restartTimes[index - 1]!))) throw new Error("Invalid restart state");
    this.restartTimes = restartTimes.slice(-3);
  }
  signal(signal: NPCSignal): void {
    if (signal === "auth-rejected") this.authFailures = Math.min(100, this.authFailures + 1);
    if (signal === "transport-closed") this.transportFailures = Math.min(100, this.transportFailures + 1);
    if (signal === "connected") { this.authFailures = 0; this.transportFailures = 0; }
  }
  evaluate(health: NPCHealth, now: number): NPCDecision {
    if (!Number.isFinite(now)) throw new Error("Invalid clock");
    if (!health.localReady) {
      this.healthFailures = 0; this.healthySince = null;
      return { action: "wait", reason: "local-unavailable" };
    }
    if (health.publicReady && health.childAlive) {
      this.healthFailures = 0; this.authFailures = 0; this.transportFailures = 0;
      if (this.healthySince === null || now < this.healthySince) this.healthySince = now;
      if (now - this.healthySince >= 300_000) this.restartTimes = [];
      return { action: "wait", reason: "healthy" };
    }
    this.healthySince = null;
    if (!health.bridgeReachable) {
      this.healthFailures = 0;
      return { action: "wait", reason: "bridge-unreachable" };
    }
    this.healthFailures = Math.min(100, this.healthFailures + 1);
    if (this.healthFailures < 3) return { action: "wait", reason: "observing" };
    const reason = !health.childAlive ? "process-exited" : this.authFailures >= 3 ? "authentication-stuck" :
      this.transportFailures >= 6 ? "transport-stuck" : null;
    if (!reason) return { action: "wait", reason: "upstream-investigation" };
    return this.checkBudget(now, reason);
  }
  startupDecision(now: number): NPCDecision {
    if (!Number.isFinite(now)) throw new Error("Invalid clock");
    return this.checkBudget(now, "process-exited");
  }
  private checkBudget(now: number, reason: NPCDecision["reason"]): NPCDecision {
    // A backwards clock fails closed rather than bypassing the restart budget.
    const last = this.restartTimes.at(-1);
    if (last !== undefined && now - last < 60_000) return { action: "wait", reason: "cooldown" };
    this.restartTimes = this.restartTimes.filter(time => now - time < 3_600_000);
    if (this.restartTimes.length >= 3) return { action: "wait", reason: "restart-budget-exhausted" };
    return { action: "restart", reason };
  }
  restarted(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0 || now < (this.restartTimes.at(-1) ?? 0)) throw new Error("Invalid clock");
    this.restartTimes.push(now);
    this.restartTimes = this.restartTimes.slice(-3);
    this.authFailures = 0; this.transportFailures = 0; this.healthFailures = 0;
  }
  state(): number[] { return [...this.restartTimes]; }
}

/** Bounded line framing, including oversized/malicious log lines. */
export class NPCOutputDecoder {
  private pending = "";
  private dropping = false;
  constructor(private readonly receive: (signal: NPCSignal) => void) {}
  append(chunk: string): void {
    for (const fragment of chunk.split(/(?<=\n)/)) {
      const complete = fragment.endsWith("\n");
      if (!this.dropping) {
        if (this.pending.length + fragment.length > 8192) {
          this.pending = ""; this.dropping = true;
        } else this.pending += fragment;
      }
      if (complete) {
        if (!this.dropping) this.receive(classifyNPCOutput(this.pending));
        this.pending = ""; this.dropping = false;
      }
    }
  }
}
