// Business identity is separate from display wording. No fuzzy text matching:
// only an explicit subject + delimited parameter set + identical answer contract
// may bridge differently worded historical configuration questions.
export function meaningfulDecisionQuestion(value) {
  if(typeof value!=='string')return false;
  const normalized=value.normalize('NFKC').trim();
  const bare=normalized.replace(/[\p{P}\p{S}\s]/gu,'').toLowerCase();
  return bare.length>1&&/[\p{L}\p{N}]/u.test(bare)
    && !/^(?:(?:decision|question|value))?(?:null|undefined|none|nil|notused|na|无|无需|不需要)$/iu.test(bare);
}
export function decisionIdentity(scope,candidate){
  const question=candidate.question.normalize('NFKC').trim();
  const identifier='`?[A-Za-z_][A-Za-z0-9_]{1,127}`?';
  const list=new RegExp(`(?:${identifier}\\s*[,、，]\\s*)+${identifier}`,'u').exec(question);
  let subject;
  if(list&&!/删除|丢弃|撤销|禁用|\b(?:delete|discard|revoke|disable)\b/iu.test(question)){
    const prefix=question.slice(0,list.index).trim().replace(/(?:的)?(?:仍)?(?:需(?:要)?批准|缺(?:少)?|需(?:要)?设置|需(?:要)?配置).*$/u,'').replace(/的$/u,'').trim();
    const parameters=[...new Set(list[0].match(/[A-Za-z_][A-Za-z0-9_]*/gu))].sort();
    if(prefix&&parameters.length>=2)subject=['configuration',prefix,parameters,[...new Set(question.match(/\d+(?:\.\d+)?/gu)??[])].sort()];
  }
  subject??=['topic',(candidate.topicKey?.trim()||question).replace(/^(?:仍需|请)\s*/u,'').replace(/\s+/gu,' ')];
  const options=(candidate.options??[]).map(o=>[o.label?.trim(),o.description??'']);
  return JSON.stringify([scope,subject,options,candidate.allowsText!==false||!options.length]);
}
