import { cp, lstat, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const forbidden = path => path.split(/[\\/]/).some(part => ['security','runtimes','client-devices','MessageOutbox','TimelineCache','DetailActionRecovery'].includes(part))
  || ['auth.json','admin-token','app-credentials.v1.json','mcp-secrets.v1.json'].includes(basename(path));
export async function verifyPreviewHasNoCredentials(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if((!entry.isDirectory() && forbidden(path)) || entry.isSymbolicLink()) throw new Error('Development preview contains excluded private data; select a clean preview.');
    if(entry.isDirectory())await verifyPreviewHasNoCredentials(path);
  }
}
export async function cloneDevelopmentPreviewData(source,target) {
  if(!((await lstat(join(source,'.preview-only'))).isFile()))throw new Error('Source must be a preview dataset.');
  await cp(source,target,{recursive:true,force:false,errorOnExist:true,filter:async path=>{
    const parts=relative(source,path).split(/[\\/]/).filter(Boolean);
    const content=parts[0]==='development'?parts.slice(1):parts;
    if(parts.length && !(parts[0]==='.preview-only' || parts[0]==='development'
      || ['database','chat-resources','artifacts'].includes(parts[0])))return false;
    if(content.length && parts[0]!=='.preview-only' && !['database','chat-resources','artifacts'].includes(content[0]))return false;
    if(forbidden(relative(source,path)))return false;
    return !(await lstat(path)).isSymbolicLink();
  }});
  await verifyPreviewHasNoCredentials(target);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,source,target]=process.argv.slice(2);
  if(mode==='verify')await verifyPreviewHasNoCredentials(source);
  else if(mode==='clone')await cloneDevelopmentPreviewData(source,target);
  else throw new Error('Expected clone or verify');
}
