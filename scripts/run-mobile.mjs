import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: make mobile [DEVICE="设备名或UDID"] [TEAM=团队ID]
       node scripts/run-mobile.mjs [--device 名称或UDID] [--team 团队ID] [--list]
仅部署当前工作区的 Debug 移动端，不拉取代码、不卸载 App、不发布。
首次使用请在 Xcode 登录账号，并在设备上信任 Mac、启用开发者模式。`;

export function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') out.help = true;
    else if (key === '--list') out.list = true;
    else if (key === '--device' || key === '--team') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} 缺少参数`);
      out[key.slice(2)] = args[++i];
    } else throw new Error(`未知参数：${key}`);
  }
  return out;
}

export function devices(document) {
  if (!Array.isArray(document.result?.devices)) throw new Error('无法识别 devicectl 设备信息，请检查 Xcode。');
  return document.result.devices.flatMap(d => {
    const { hardware: h = {}, state: s = {}, connection: c = {} } = d.properties ?? {};
    if (h.reality !== 'physical' || !['iPhone', 'iPad'].includes(h.deviceType)) return [];
    return [{ id: d.identifier, udid: h.udid, name: s.name ?? h.deviceType,
      state: c.state, paired: c.pairingState === 'paired',
      developer: Object.hasOwn(s.developerModeStatus ?? {}, 'enabled') }];
  });
}

export function ready(d) {
  return ['connected', 'available'].includes(d.state) && d.paired && d.developer && Boolean(d.udid);
}

export async function selectDevice(all, requested, choose) {
  if (requested) {
    const matches = all.filter(d => [d.id, d.udid, d.name].includes(requested));
    if (matches.length !== 1) throw new Error('设备名称不存在或不唯一，请用 --list 查看并指定 UDID。');
    if (!ready(matches[0])) throw new Error('目标设备未就绪：请连接并解锁设备、信任此 Mac、启用开发者模式。');
    return matches[0];
  }
  const candidates = all.filter(ready);
  if (!candidates.length) throw new Error('没有就绪的 iPhone/iPad。请连接并解锁设备、信任此 Mac、启用开发者模式后重试。');
  if (candidates.length === 1) return candidates[0];
  if (!choose) throw new Error('多台设备可用，请指定 DEVICE="设备名或UDID"，不会自动任选一台。');
  const index = await choose(candidates);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) throw new Error('无效设备序号。');
  return candidates[index];
}

function command(bin, args, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(bin, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? accept(output) : reject(new Error(`${bin} 失败（${signal ?? code}）`)));
  });
}

export async function deploy(device, team, run = command, read = readFile) {
  console.log(`[1/3] 编译并自动签名：${device.name}`);
  const derived = resolve(root, 'apps/ipad/.build-device');
  const args = ['-project', resolve(root, 'apps/ipad/CorptieMobile.xcodeproj'),
    '-scheme', 'CorptieMobile', '-configuration', 'Debug', '-destination', `platform=iOS,id=${device.udid}`,
    '-derivedDataPath', derived, '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
    'CODE_SIGN_STYLE=Automatic', ...(team ? [`DEVELOPMENT_TEAM=${team}`] : []), 'build'];
  try { await run('xcodebuild', args); }
  catch (e) { throw new Error(`编译/签名未完成，未安装。若提示账号或描述文件错误，请在 Xcode → Settings → Accounts 检查登录与 Team。\n${e.message}`); }
  const app = resolve(derived, 'Build/Products/Debug-iphoneos/CorptieMobile.app');
  // Read the actual built identifier, rather than duplicating project signing settings.
  const bundle = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${app}/Info.plist`], true)).trim();
  if (!bundle || !bundle.endsWith('.development')) throw new Error('构建产物不是 Development Bundle，拒绝覆盖安装。');
  await read(`${app}/embedded.mobileprovision`);
  console.log('[2/3] 覆盖安装（不卸载、不主动清除 App 数据）');
  try { await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.id, '--timeout', '120', app]); }
  catch (e) { throw new Error(`安装失败，未尝试启动；请检查设备连接、可用空间及签名信任。\n${e.message}`); }
  console.log('[3/3] 启动');
  try { await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.id,
    '--timeout', '30', '--terminate-existing', bundle]); }
  catch (e) { throw new Error(`安装已完成，但启动失败。请解锁设备，按系统提示信任开发者，或手动点击 App。\n${e.message}`); }
  console.log(`完成：${device.name} 已安装并启动当前工作区版本。`);
}

async function main() {
  const opts = options(process.argv.slice(2));
  opts.device ??= process.env.DEVICE || undefined;
  opts.team ??= process.env.TEAM || undefined;
  if (opts.help) return console.log(usage);
  if (process.platform !== 'darwin') throw new Error('需要安装完整 Xcode 的 macOS。');
  await command('xcrun', ['--find', 'devicectl'], true);
  await command('xcrun', ['--find', 'xcodebuild'], true);
  const all = devices(JSON.parse(await command('xcrun', ['devicectl', 'list', 'devices', '--timeout', '20', '--json-output', '-'], true)));
  for (const d of all) console.log(`${d.name} | ${d.udid} | ${ready(d) ? '就绪' : '未就绪'} (${d.state ?? 'unknown'})`);
  if (opts.list) return;
  const choose = process.stdin.isTTY ? async candidates => {
    candidates.forEach((d, i) => console.log(`${i + 1}. ${d.name} (${d.udid})`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return Number(await prompt.question('选择设备序号：')) - 1; }
    finally { prompt.close(); }
  } : undefined;
  await deploy(await selectDevice(all, opts.device, choose), opts.team);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`移动端更新失败：${error.message}`); process.exitCode = 1; });
}
