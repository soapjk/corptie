import test from 'node:test';
import assert from 'node:assert/strict';
import { options, devices, ready, selectDevice, deploy } from '../run-mobile.mjs';

const phone = { id: 'core-phone', udid: 'udid-phone', name: '手机', state: 'connected', paired: true, developer: true };
test('options reject unknown or missing flags', () => {
  assert.deepEqual(options(['--device', '手机', '--team', 'TEAM']), { device: '手机', team: 'TEAM' });
  assert.throws(() => options(['--bad']));
  assert.throws(() => options(['--device']));
});
test('modern CoreDevice properties select only physical iPhone/iPad', () => {
  const properties = { hardware: { deviceType: 'iPhone', reality: 'physical', udid: 'udid-phone' },
    state: { name: '手机', developerModeStatus: { enabled: {} } }, connection: { state: 'connected', pairingState: 'paired' } };
  assert.deepEqual(devices({ result: { devices: [{ identifier: 'core-phone', properties }] } }), [phone]);
  assert.deepEqual(devices({ result: { devices: [{ properties: { ...properties, hardware: { deviceType: 'appleWatch', reality: 'physical' } } }] } }), []);
  assert.throws(() => devices({}));
});
test('selection handles no, one, multiple, ambiguous and unavailable devices', async () => {
  await assert.rejects(selectDevice([], undefined));
  assert.equal(await selectDevice([phone]), phone);
  assert.equal(ready({ ...phone, developer: false }), false);
  assert.equal(ready({ ...phone, state: 'unavailable' }), false);
  await assert.rejects(selectDevice([{ ...phone, state: 'unavailable' }], phone.udid));
  const pad = { ...phone, id: 'pad', udid: 'pad', name: '平板' };
  await assert.rejects(selectDevice([phone, pad]));
  assert.equal(await selectDevice([phone, pad], undefined, async () => 1), pad);
  assert.equal(await selectDevice([phone, pad], 'pad'), pad);
  await assert.rejects(selectDevice([phone, pad], undefined, async () => -1));
  await assert.rejects(selectDevice([phone, { ...pad, name: phone.name }], phone.name));
});
test('pipeline signs, installs and launches sequentially without shell or file writes', async () => {
  const calls = [];
  await deploy(phone, 'TEAM', async (bin, args) => {
    calls.push([bin, args]);
    return bin.includes('PlistBuddy') ? 'com.corptie.ipad.development\n' : '';
  }, async () => {});
  assert.equal(calls.length, 4);
  assert.ok(calls[0][1].includes('DEVELOPMENT_TEAM=TEAM'));
  assert.ok(calls[0][1].includes('platform=iOS,id=udid-phone'));
  assert.ok(calls[2][1].includes('install'));
  assert.ok(calls[3][1].includes('--terminate-existing'));
});
test('failed build prevents installation; launch error distinguishes installed state', async () => {
  let calls = 0;
  await assert.rejects(deploy(phone, null, async () => { calls++; throw new Error('signing'); }), /未安装/);
  assert.equal(calls, 1);
  await assert.rejects(deploy(phone, null, async (bin, args) => {
    if (bin.includes('PlistBuddy')) return 'com.corptie.ipad.development';
    if (args.includes('launch')) throw new Error('locked');
    return '';
  }, async () => {}), /安装已完成/);
});
test('non-development artifact is never installed', async () => {
  let installed = false;
  await assert.rejects(deploy(phone, null, async (bin, args) => {
    if (args.includes('install')) installed = true;
    return bin.includes('PlistBuddy') ? 'com.corptie.ipad' : '';
  }), /拒绝覆盖/);
  assert.equal(installed, false);
});
