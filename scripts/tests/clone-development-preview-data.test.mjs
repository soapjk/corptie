import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloneDevelopmentPreviewData,verifyPreviewHasNoCredentials} from '../clone-development-preview-data.mjs';
test('preview copying excludes secrets before copying and retains source evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'corptie-preview-'));
 try{
  const source=join(root,'source'),target=join(root,'target');
  await mkdir(join(source,'development','security'),{recursive:true});await mkdir(join(source,'development','database'));
  await writeFile(join(source,'.preview-only'),'preview');await writeFile(join(source,'development','database','corptie.sqlite'),'synthetic');
  await writeFile(join(source,'development','security','mcp-secrets.v1.json'),'never copy');
  await cloneDevelopmentPreviewData(source,target);
  assert.equal(await readFile(join(target,'development','database','corptie.sqlite'),'utf8'),'synthetic');
  await assert.rejects(stat(join(target,'development','security')),{code:'ENOENT'});
  await assert.rejects(verifyPreviewHasNoCredentials(source));
  assert.equal(await readFile(join(source,'development','security','mcp-secrets.v1.json'),'utf8'),'never copy');
 }finally{await rm(root,{recursive:true,force:true});}
});
