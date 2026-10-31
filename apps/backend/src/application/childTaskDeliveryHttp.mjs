// Shared native routes. Callers authenticate the user before entering; no
// Provider, tool, or Session-supplied actor metadata is accepted here.
export async function handleChildTaskDeliveryHttp({request,response,url,prefix="",service,completion,actor,revalidate,readJson,sendJson,writesAllowed=true}) {
  const path=url.pathname.slice(prefix.length);
  const status=path.match(/^\/tasks\/([^/]+)\/child-delivery$/);
  const page=path.match(/^\/tasks\/([^/]+)\/child-deliveries$/);
  const operation=path.match(/^\/child-deliveries\/([^/]+)(\/retry)?$/);
  const acceptance=prefix && path.match(/^\/tasks\/([^/]+)\/(completion-intents|confirm-completion)$/);
  if(!status && !page && !operation && !acceptance) return false;
  if(!writesAllowed && request.method!=="GET") throw error("DEVELOPMENT_PREVIEW_READ_ONLY","Preview delivery records are read-only.",403);
  if(!service || !completion) throw error("CAPABILITY_UNAVAILABLE","Child delivery is unavailable.",503);
  revalidate();
  if(request.method==="GET" && status) {
    const task=service.store.getTask(decodeURIComponent(status[1]));
    if(!task) throw error("TASK_NOT_FOUND","Task not found.",404);
    const latest=service.store.selectOne("SELECT operation_id FROM child_task_delivery_operations WHERE child_task_id=? ORDER BY rowid DESC LIMIT 1",[task.id]);
    sendJson(response,200,{taskId:task.id,title:task.title,parentTaskId:task.parent_task_id ?? null,
      operation:latest ? service.read(latest.operation_id) : null});
  } else if(request.method==="GET" && page) {
    if([...url.searchParams.keys()].some(key=>!["cursor","limit"].includes(key))) throw error("INVALID_QUERY","Invalid query.",400);
    sendJson(response,200,service.listParentDeliveries(decodeURIComponent(page[1]),url.searchParams.get("cursor"),url.searchParams.get("limit")));
  } else if(operation && request.method==="GET" && !operation[2]) {
    const value=service.read(decodeURIComponent(operation[1]));
    if(!value) throw error("CHILD_DELIVERY_NOT_FOUND","Delivery not found.",404);
    sendJson(response,200,value);
  } else if(operation?.[2] && request.method==="POST") {
    revalidate(); sendJson(response,200,service.retry(decodeURIComponent(operation[1])));
  } else if(acceptance && request.method==="POST") {
    const input=await readJson(request),taskId=decodeURIComponent(acceptance[1]);
    const allowed=acceptance[2]==="completion-intents"
      ? ["requestId","interactionId","uiSurface","displayedTaskId","displayedTaskTitle","displayedAcceptanceStatus"]
      : ["intentToken","requestId","idempotencyKey"];
    if(Object.keys(input).some(key=>!allowed.includes(key))) throw error("INVALID_INPUT","Unknown completion field.",400);
    const result=acceptance[2]==="completion-intents"
      ? await completion.issueUserIntent(taskId,input,actor,{revalidate})
      : await completion.completeFromUser(taskId,input,actor,{revalidate});
    sendJson(response,200,result);
  } else throw error("METHOD_NOT_ALLOWED","Method not allowed.",405);
  return true;
}
function error(code,message,statusCode) { return Object.assign(new Error(message),{code,statusCode}); }
