import assert from "node:assert/strict";
import test from "node:test";
import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { TaskIntegrationAcceptanceService } from "../src/application/taskIntegrationAcceptanceService.mjs";
import { rejectDevelopmentPreviewWrite } from "../src/application/backendHttpGuards.mjs";

function request(path, input={}, headers={}) {
  return { method:"POST",url:path,headers:{"content-type":"application/json",...headers},socket:{remoteAddress:"127.0.0.1"},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(input)); } };
}
function response() {
  let done;
  const completed=new Promise(resolve=>{done=resolve;});
  return {completed,headersSent:false,statusCode:0,writeHead(code) {this.statusCode=code;},
    end(value) {this.headersSent=true;this.body=JSON.parse(value);done();}};
}

test("desktop manual acceptance uses the trusted product actor and refuses Agent headers",async()=>{
  const calls=[];
  const integrationAcceptance={prepareUserApproval:async(...args)=>{calls.push(args);return {intentId:"intent:test"};},
    confirmUserApproval:async(...args)=>{calls.push(args);return {approvalSource:"manual_user"};}};
  for(const action of ["intents","confirmations"]) {
    const path=`/tasks/task:p/integration-acceptance-${action}`;
    const req=request(path),res=response();
    assert.equal(handleEntityHttpRequest({request:req,response:res,url:new URL(path,"http://localhost"),workService:{integrationAcceptance}}),true);
    await res.completed;
    assert.equal(res.statusCode,200);
    assert.deepEqual(calls.at(-1)[2],{type:"user",id:"user:local-macos"});
    const denied=response();
    handleEntityHttpRequest({request:request(path,{}, {"x-corptie-agent-id":"agent:a"}),response:denied,
      url:new URL(path,"http://localhost"),workService:{integrationAcceptance}});
    await denied.completed;
    assert.equal(denied.statusCode,403);
    assert.equal(denied.body.code,"DIRECT_USER_INTENT_REQUIRED");
  }
  assert.equal(calls.length,2);
});

test("paired manual approval reauthorizes the same device before persisting",async()=>{
  const originals=[TaskIntegrationAcceptanceService.prototype.prepareUserApproval,TaskIntegrationAcceptanceService.prototype.confirmUserApproval];
  try {
    let actor,checks=0;
    const run=async function(taskId,input,user,options) { actor=user;options.revalidate();return {taskId,approvalSource:"manual_user"}; };
    TaskIntegrationAcceptanceService.prototype.prepareUserApproval=run;
    TaskIntegrationAcceptanceService.prototype.confirmUserApproval=run;
    const gateway=new ClientDeviceGateway({}, {readAPI:{store:{}},worktreeAPI:{}});
    gateway.authenticateRequest=()=>{checks++;return {deviceId:"paired"};};
    for(const action of ["intents","confirmations"]) {
      const path=`/client/v1/tasks/task:p/integration-acceptance-${action}`,res=response();
      await gateway.handle(request(path),res);
      assert.equal(res.statusCode,200);
      assert.deepEqual(actor,{type:"user",id:"user:device:paired"});
    }
    assert.equal(checks,4);
    let count=0;
    gateway.authenticateRequest=()=>{if(count++) throw Object.assign(new Error("revoked"),{code:"DEVICE_REVOKED",statusCode:403});return {deviceId:"paired"};};
    const denied=response();
    await gateway.handle(request("/client/v1/tasks/task:p/integration-acceptance-confirmations"),denied);
    assert.equal(denied.statusCode,403);
  } finally {
    [TaskIntegrationAcceptanceService.prototype.prepareUserApproval,TaskIntegrationAcceptanceService.prototype.confirmUserApproval]=originals;
  }
});

test("read-only Development preview never permits user approval writes",()=>{
  for(const action of ["intents","confirmations"]) {
    let status;
    const path=`/tasks/task:p/integration-acceptance-${action}`;
    assert.equal(rejectDevelopmentPreviewWrite({request:request(path),response:{},url:new URL(path,"http://localhost"),
      developmentPreview:true,sendJson:(_,code)=>{status=code;}}),true);
    assert.equal(status,403);
  }
});
