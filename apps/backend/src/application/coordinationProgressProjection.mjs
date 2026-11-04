// Pure presentation projection. Session/dispatch/acceptance authorities supply
// facts; this module never changes execution or infers acceptance from a reply.
export const COORDINATION_PROGRESS_STATES = Object.freeze([
  'preparing', 'queued', 'running', 'waiting_input', 'blocked', 'needs_review', 'delivered', 'accepted', 'cancelled'
]);
const rank = Object.freeze({ waiting_input:0, blocked:1, running:2, preparing:3, queued:4, needs_review:5, delivered:6, accepted:7, cancelled:8 });
export function projectCoordinationAssignment(input) {
  let state;
  if (input.acceptanceVerified === true) state = 'accepted';
  else if (input.deliveryVerified === true) state = 'delivered';
  else if (input.dispatchState === 'cancelled') state = 'cancelled';
  else if (input.inconsistent === true || ['completed','unknown'].includes(input.dispatchState)) state = 'needs_review';
  else if (input.waitingInput === true) state = 'waiting_input';
  else if (input.dispatchState === 'blocked' || input.dispatchState === 'failed') state = 'blocked';
  else if (['accepted','preparing','waiting_workspace'].includes(input.dispatchState)) state = 'preparing';
  else if (['queued','waiting_dispatch'].includes(input.dispatchState)) state = 'queued';
  else if (input.executionState === 'running' || input.dispatchState === 'running') state = 'running';
  else state = 'needs_review';
  return { assignmentId:input.assignmentId, taskId:input.taskId ?? null, sessionId:input.sessionId ?? null,
    title:input.title, state, summary:input.summary ?? '', reason:input.reason ?? '',
    reportMessageId:input.reportMessageId ?? null, updatedAt:input.updatedAt };
}
export function projectCoordinationProgress({ batchId, parentSessionId, revision, updatedAt, assignments, focus = '', decision = '' }) {
  if (!batchId || !parentSessionId || assignments.length > 10000) throw new TypeError('Invalid coordination progress input.');
  const counts = Object.fromEntries(COORDINATION_PROGRESS_STATES.map(state => [state, 0]));
  const ids = new Set();
  const items = assignments.map(input => {
    if (!input.assignmentId || ids.has(input.assignmentId)) throw new TypeError('Duplicate coordination assignment.');
    ids.add(input.assignmentId);
    const row = projectCoordinationAssignment(input); counts[row.state]++; return row;
  }).sort((a,b) => rank[a.state] - rank[b.state] || a.assignmentId.localeCompare(b.assignmentId));
  return { version:1, batchId, parentSessionId, revision, updatedAt, counts, total:items.length,
    items:items.slice(0,3), hasMore:items.length>3, focus, decision };
}

const string={type:'string',maxLength:1000};
const nullableId={type:['string','null'],maxLength:512};
export const coordinationProgressSchema={type:'object',additionalProperties:false,
 required:['version','batchId','parentSessionId','revision','updatedAt','counts','total','items','hasMore','focus','decision'],properties:{
 version:{const:1},batchId:{type:'string',maxLength:512},parentSessionId:{type:'string',maxLength:512},revision:{type:'integer',minimum:0},updatedAt:string,
 counts:{type:'object',additionalProperties:{type:'integer',minimum:0},maxProperties:9},total:{type:'integer',minimum:0,maximum:10000},
 items:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,
 required:['assignmentId','taskId','sessionId','title','state','summary','reason','reportMessageId','updatedAt'],properties:{
 assignmentId:{type:'string',maxLength:512},taskId:nullableId,sessionId:nullableId,title:string,state:{enum:COORDINATION_PROGRESS_STATES},summary:string,reason:{type:'string',maxLength:2000},reportMessageId:nullableId,updatedAt:string}}},hasMore:{type:'boolean'},focus:string,decision:string}};
