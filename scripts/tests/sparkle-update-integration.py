#!/usr/bin/env python3
"""Local full-bundle Sparkle integration test; never starts the product entry point."""
import os, sys, pathlib, tempfile, subprocess, plistlib, shutil, http.server, threading, time, urllib.request, json
source = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='sparkle-ab-', dir='/Volumes/T9/.corptie/tmp'))
print('TEST_ROOT='+str(root), flush=True)
def run(*args): return subprocess.check_output([str(x) for x in args], stderr=subprocess.STDOUT).decode().strip()
for name in ['events.log','backend.log']: (root/name).touch()
(root/'workspace').mkdir()
# Fail before touching bundles if either test port is occupied.
import socket, sqlite3
for port in [49280,49281]:
 with socket.socket() as s:
  s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
  s.bind(('127.0.0.1',port))
keycode = "const c=require('node:crypto'),f=require('node:fs');let k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),{mode:0o600});console.log(k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'));"
public = run('node','-e',keycode,root/'key')
framework = source/'Contents/MacOS'
run('clang','-fobjc-arc','-framework','Cocoa','-F',framework,'-framework','Sparkle','-Wl,-rpath,@executable_path',repo/'scripts/tests/sparkle-update-harness.m','-o',root/'Harness')
identifier='com.corptie.sparkle-test.'+root.name
for version in ['1','2']:
 app=root/('A' if version=='1' else 'B')/'Corptie.app'; app.parent.mkdir()
 run('ditto',source,app)
 shutil.copy2(root/'Harness',app/'Contents/MacOS/Corptie')
 plist=app/'Contents/Info.plist'; info=plistlib.loads(plist.read_bytes())
 info.update(CFBundleIdentifier=identifier,CFBundleExecutable='Corptie',CFBundleVersion=version,CFBundleShortVersionString='0.0.'+version,CorptieTestRoot=str(root),SUFeedURL='http://127.0.0.1:49280/appcast.xml',SUPublicEDKey=public,SUEnableAutomaticChecks=False,SUVerifyUpdateBeforeExtraction=True,NSAppTransportSecurity={'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True})
 info.pop('CFBundleURLTypes',None)
 plist.write_bytes(plistlib.dumps(info))
 run('codesign','--force','--sign','-',app/'Contents/MacOS/Corptie')
 run('codesign','--force','--sign','-',app)
 run('codesign','--verify','--deep','--strict',app)
run('ditto','-c','-k','--sequesterRsrc','--keepParent',root/'B/Corptie.app',root/'update.zip')
signer=repo/'apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update'
signature=run(signer,'--ed-key-file',root/'key','-p',root/'update.zip')
feed='<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Local test</title><item><sparkle:version>2</sparkle:version><enclosure url="http://127.0.0.1:49280/update.zip" sparkle:edSignature="%s" length="%s" type="application/octet-stream"/></item></channel></rss>'
bad = '--bad-signature' in sys.argv
if bad: signature = ('A' if signature[0] != 'A' else 'B') + signature[1:]
(root/'data').mkdir(exist_ok=True)
(root/'data/sentinel').write_text('preserved-user-data')
(root/'appcast.xml').write_text(feed%(signature,(root/'update.zip').stat().st_size))
class Handler(http.server.SimpleHTTPRequestHandler):
 def do_GET(self):
  if self.path not in ['/appcast.xml','/update.zip']: self.send_error(404); return
  super().do_GET()
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(root),**kw)
server=http.server.ThreadingHTTPServer(('127.0.0.1',49280),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
process=subprocess.Popen([str(root/'A/Corptie.app/Contents/MacOS/Corptie')],stdout=open(root/'app.log','w'),stderr=subprocess.STDOUT)
try:
 for _ in range(60):
  try:
   health=json.load(urllib.request.urlopen('http://127.0.0.1:49281/health',timeout=2))
   if health.get('storeReady'): break
  except Exception: pass
  time.sleep(1)
 else: raise RuntimeError('initial backend never ready')
 database=root/'data/development/database/corptie.sqlite'
 with sqlite3.connect(database) as db:
  db.execute('CREATE TABLE update_test_sentinel (value TEXT)')
  db.execute("INSERT INTO update_test_sentinel VALUES ('preserved-sqlite-data')")
 (root/'start-update').touch()
 for _ in range(90):
  time.sleep(2)
  events=(root/'events.log').read_text()
  if 'LAUNCH 2' in events:
   for attempt in range(30):
    try:
     health=json.load(urllib.request.urlopen('http://127.0.0.1:49281/health'))
     if health.get('storeReady'): print('UPDATED_HEALTH='+json.dumps(health),flush=True);break
    except Exception:pass
    time.sleep(1)
   else:raise RuntimeError('updated backend never ready')
   assert plistlib.loads((root/'A/Corptie.app/Contents/Info.plist').read_bytes())['CFBundleVersion']=='2'
   assert (root/'data/sentinel').read_text()=='preserved-user-data'
   with sqlite3.connect(database) as db:
    assert db.execute('SELECT value FROM update_test_sentinel').fetchone()[0]=='preserved-sqlite-data'
   print('DATA_PRESERVED=true SQLITE_PRESERVED=true',flush=True)
   print(events,flush=True);break
  if 'ERROR ' in events:
   if bad:
    assert 'EdDSA signature does not match' in events
    assert plistlib.loads((root/'A/Corptie.app/Contents/Info.plist').read_bytes())['CFBundleVersion']=='1'
    assert 'LAUNCH 2' not in events
    print('BAD_SIGNATURE_REJECTED=true\n'+events,flush=True);break
   raise RuntimeError(events)
 else:raise RuntimeError('Timed out: '+events)
finally:
 server.shutdown()
 server.server_close()
 import signal
 for line in subprocess.check_output(['ps','-axo','pid=,command=']).decode().splitlines():
  pid,_,command=line.strip().partition(' ')
  if command.startswith(str(root)+'/'):
   try: os.kill(int(pid),signal.SIGTERM)
   except ProcessLookupError: pass
 process.wait(timeout=10)
 print('EVIDENCE='+str(root),flush=True)
