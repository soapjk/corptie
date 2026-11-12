#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8' }).trim();
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Update URLs must use HTTPS without credentials');
  return url.href;
}
export function publicKey(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value ?? '') || Buffer.from(value, 'base64').length !== 32) throw new Error('A 32-byte base64 Ed25519 public key is required');
  return value;
}
export function keyMatches(seedText, expectedPublicKey) {
  const seed = Buffer.from(seedText.trim(), 'base64');
  if (seed.length !== 32) throw new Error('Use a 32-byte base64 Ed25519 seed file');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  if (derived !== publicKey(expectedPublicKey)) throw new Error('Signing key does not match the app public key');
}
export function appcast({ version, build, url, signature, length, notes = '' }) {
  if (!/^\d+(\.\d+)*$/.test(build) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid update version');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid update signature or size');
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Corptie Updates</title><item><title>${xml(version)}</title><description>${xml(notes)}</description><sparkle:version>${xml(build)}</sparkle:version><sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0.0</sparkle:minimumSystemVersion><enclosure url="${xml(httpsURL(url))}" sparkle:edSignature="${xml(signature)}" length="${length}" type="application/octet-stream"/></item></channel></rss>\n`;
}

function main([command, app, output]) {
  const env = process.env;
  const plist = path.join(app, 'Contents/Info.plist');
  const get = key => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
  if (command === 'configure') {
    if (!env.CORPTIE_UPDATE_FEED_URL && !env.CORPTIE_UPDATE_PUBLIC_KEY) return;
    const feed = httpsURL(env.CORPTIE_UPDATE_FEED_URL);
    const key = publicKey(env.CORPTIE_UPDATE_PUBLIC_KEY);
    for (const [name, value] of [['SUFeedURL', feed], ['SUPublicEDKey', key]]) {
      run('/usr/bin/plutil', ['-replace', name, '-string', value, plist]);
    }
    run('/usr/bin/plutil', ['-replace', 'SUVerifyUpdateBeforeExtraction', '-bool', 'YES', plist]);
    return;
  }
  if (command !== 'archive' || !output) throw new Error('Usage: macos-update.mjs configure APP | archive APP OUTPUT');
  httpsURL(get('SUFeedURL'));
  publicKey(get('SUPublicEDKey'));
  // Always use a file key. Never fall through to Sparkle Keychain discovery.
  const keyFile = env.CORPTIE_UPDATE_PRIVATE_KEY_FILE;
  const signTool = env.CORPTIE_SPARKLE_SIGN_UPDATE;
  if (!keyFile || !signTool || !fs.statSync(keyFile).isFile()) throw new Error('Set CORPTIE_UPDATE_PRIVATE_KEY_FILE and CORPTIE_SPARKLE_SIGN_UPDATE');
  keyMatches(fs.readFileSync(keyFile, 'utf8'), get('SUPublicEDKey'));
  const version = get('CFBundleShortVersionString');
  const build = get('CFBundleVersion');
  const name = `Corptie-${version}-${build}.zip`;
  const url = httpsURL(`${env.CORPTIE_UPDATE_DOWNLOAD_BASE_URL?.replace(/\/$/, '')}/${name}`);
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, name);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const signature = run(signTool, ['--ed-key-file', keyFile, '-p', archive]);
  run(signTool, ['--ed-key-file', keyFile, '--verify', archive, signature]);
  const feed = appcast({ version, build, url, signature, length: fs.statSync(archive).size, notes: env.CORPTIE_UPDATE_RELEASE_NOTES });
  fs.writeFileSync(path.join(output, 'appcast.xml'), feed);
  console.log(`Created signed update ${name} and appcast.xml (local only)`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
