import { parentPort, workerData } from 'node:worker_threads';
import { CorptieStore } from './corptieStore.mjs';
const store = new CorptieStore({...workerData,manageProcessEnvironment:false});
try {
  await store.initialize({resolveDataPath:false,performMigrations:false,initializeRuntimeIndexes:false});
  parentPort.postMessage({type:'ready'});
} catch(error) { parentPort.postMessage({type:'fatal',error:serialize(error)}); }
parentPort.on('message',({requestId,operation,input})=>{
  try {
    let result;
    if(operation==='admitUserMessage') {
      result=store.runInTransaction(()=>{
        const session=store.getSession(input.sessionId);
        const route=store.getLogicalSessionByLegacySessionId(input.sessionId);
        if(!session || session.deletedAt || session.archived || session.status==='deleted')
          throw Object.assign(new Error('Session is unavailable.'),{code:'SESSION_UNAVAILABLE',statusCode:409});
        if(route?.activeBinding?.bindingId!==input.binding.bindingId || route?.activeBinding?.state!=='active' || route?.transitionState)
          throw Object.assign(new Error('Session binding changed before admission.'),{code:'STALE_WORKSPACE_ROUTE',statusCode:409});
        return store.createUserMessageDelivery(input);
      });
    } else if (operation==='claimSessionWork') {
      result=store.runInTransaction(()=>store.claimAgentTask(input.taskId));
    } else throw new Error('Unsupported Session write operation');
    const payload=new TextEncoder().encode(JSON.stringify(result));
    parentPort.postMessage({type:'result',requestId,payload},[payload.buffer]);
  } catch(error) { parentPort.postMessage({type:'result',requestId,error:serialize(error)}); }
});
function serialize(error) { return {name:error.name,message:error.message,code:error.code,statusCode:error.statusCode}; }
