import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { contractError, evidenceHash } from "./receiptContracts.mjs";
const execFile = promisify(execFileCallback);

export class ProcessSupervisor {
  constructor({ observe = observeProcess, signal = process.kill, clock = () => new Date() } = {}) { this.observe=observe;this.signal=signal;this.clock=clock; }

  async identity(pid, { runToken, fencingToken, pgid = pid } = {}) {
    const observed=await this.observe(pid); if(!observed)return null;
    return { pid, kernelStartTime:observed.kernelStartTime, processGroupId:pgid, executableRealpathHash:sha256(observed.executableRealpath), runTokenHash:sha256(runToken), fencingToken };
  }

  async reconcile(expected) {
    const current=await this.observe(expected.pid);
    if(!current)return { status:"esrch",evidenceHash:evidenceHash({pid:expected.pid,status:"esrch"}) };
    const executableHash=sha256(current.executableRealpath);
    if(current.kernelStartTime!==expected.kernelStartTime)return {status:"pidReused",evidenceHash:evidenceHash(current)};
    if(executableHash!==expected.executableHash)return {status:"foreign",evidenceHash:evidenceHash(current)};
    return {status:"matchedRunning",evidenceHash:evidenceHash(current)};
  }

  async terminate(expected,{graceMilliseconds=2_000}={}) {
    const before=await this.reconcile(expected); if(before.status==="esrch")return {status:"esrch"};
    if(before.status!=="matchedRunning")return before;
    const signalTarget=expected.pgid===expected.pid?-expected.pgid:expected.pid;
    try{this.signal(signalTarget,"SIGTERM");}catch(error){if(error?.code==="ESRCH")return {status:"esrch"};if(error?.code==="EPERM")return {status:"indeterminate",evidenceHash:evidenceHash({code:error.code})};throw error;}
    const deadline=Date.now()+graceMilliseconds;
    while(Date.now()<deadline){const state=await this.reconcile(expected);if(state.status==="esrch")return {status:"matchedExited"};await new Promise(r=>setTimeout(r,20));}
    const again=await this.reconcile(expected);if(again.status!=="matchedRunning")return again;
    try{this.signal(signalTarget,"SIGKILL");}catch(error){if(error?.code!=="ESRCH")return {status:"indeterminate",evidenceHash:evidenceHash({code:error.code})};}
    const killed=await this.reconcile(expected);if(killed.status==="esrch")return {status:"matchedExited"};if(killed.status!=="matchedRunning")return killed;
    const killDeadline=Date.now()+graceMilliseconds;
    while(Date.now()<killDeadline){const state=await this.reconcile(expected);if(state.status==="esrch")return {status:"matchedExited"};if(state.status!=="matchedRunning")return state;await new Promise(r=>setTimeout(r,20));}
    return {status:"indeterminate",evidenceHash:evidenceHash({pid:expected.pid,phase:"post_sigkill_timeout"})};
  }
}

async function observeProcess(pid){
  try{
    const {stdout}=await execFile("/bin/ps",["-p",String(pid),"-o","lstart=","-o","state=","-o","comm="]);
    const row=stdout.trim();if(row.length<27)throw new Error("incomplete process identity");
    const kernelStartTime=row.slice(0,24).trim();const remainder=row.slice(24).trim();const separator=remainder.search(/\s/u);if(separator<1)throw new Error("incomplete process state");
    const state=remainder.slice(0,separator);const command=remainder.slice(separator).trim();if(state.startsWith("Z"))return null;if(!kernelStartTime||!command)throw new Error("incomplete process identity");
    const executableRealpath=await realpath(command); return {kernelStartTime,executableRealpath};
  }catch(error){
    if(error?.code===1||error?.code==="ESRCH")return null;
    if(error?.code==="ENOENT"){try{process.kill(pid,0)}catch(probe){if(probe?.code==="ESRCH")return null}}
    throw contractError("RUN_PROCESS_IDENTITY_INDETERMINATE","Process identity cannot be observed.");
  }
}
function sha256(value){return createHash("sha256").update(String(value),"utf8").digest("hex")}
