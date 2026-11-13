import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionApplicationService } from '../src/agent-provider/sessionApplicationService.mjs';
import { AGENT_PROVIDER_CAPABILITIES as C } from '../src/agent-provider/contracts.mjs';
import { sessionActionAvailability } from '../src/agent-provider/sessionActions.mjs';
import { CodexAppServerClient } from '../src/adapters/codexAppServer.mjs';
import { createCodexTurnDispatcher } from '../src/adapters/codexTurnDispatcher.mjs';

function fixture({ supported = true, status = 'complete', tier = 'default' } = {}) {
  const calls = [];
  const session = { id: 's', status, external: { currentModel: 'm', currentServiceTier: tier } };
  const provider = { descriptor: { id: 'engine', capabilities: supported ? [C.SERVICE_TIER_SWITCH] : [] } };
  const service = new SessionApplicationService({
    resolveSessionReference: async () => ({ sessionId: 's', providerId: 'engine', providerSessionId: 't', metadata: { session } }),
    registry: { get: () => provider, invoke: async (_provider, capability, ...args) => {
      if (capability === C.MODEL_LIST) return { models: [{ id: 'm', serviceTiers: [{ id: 'priority' }] }, { id: 'other', serviceTiers: [] }] };
      calls.push([capability, args[1]]);
      if (capability === C.SERVICE_TIER_SWITCH) session.external.currentServiceTier = args[1];
      return session;
    } }
  });
  return { service, calls, session, provider };
}

test('tier validates supported model, explicit standard reset, and capability', async () => {
  const f = fixture();
  await f.service.switchServiceTier('s', 'priority');
  assert.equal(f.session.external.currentServiceTier, 'priority');
  await f.service.switchServiceTier('s', 'default');
  assert.equal(f.session.external.currentServiceTier, 'default');
  await assert.rejects(f.service.switchServiceTier('s', 'ultrafast'), { code: 'SERVICE_TIER_UNSUPPORTED' });
  const unsupported = fixture({ supported: false });
  await assert.rejects(unsupported.service.switchServiceTier('s', 'priority'), { code: 'CAPABILITY_UNSUPPORTED' });
  assert.deepEqual(unsupported.calls, []);
});

test('busy session does not change tier; unsupported model resets before switching', async () => {
  const busy = fixture({ status: 'running' });
  await assert.rejects(busy.service.switchServiceTier('s', 'priority'), { code: 'SESSION_BUSY' });
  assert.deepEqual(busy.calls, []);
  assert.equal(sessionActionAvailability('switchServiceTier', busy.session, busy.provider).available, false);
  const f = fixture({ tier: 'priority' });
  await f.service.switchModel('s', 'other');
  assert.deepEqual(f.calls, [[C.SERVICE_TIER_SWITCH, 'default'], [C.MODEL_SWITCH, 'other']]);
});

test('Codex wire carries explicit tier including standard to first and later turns', async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  const requests = [];
  client.request = async (method, params) => { requests.push([method, params]); return { turn: { id: 'turn' } }; };
  for (const tier of ['priority', 'default']) {
    await client.updateThreadSettings('t', { serviceTier: tier });
    await client.startTurn('t', 'hello', { serviceTier: tier });
  }
  assert.deepEqual(requests.map(([method, params]) => [method, params.serviceTier]), [
    ['thread/settings/update', 'priority'], ['turn/start', 'priority'],
    ['thread/settings/update', 'default'], ['turn/start', 'default']
  ]);
});

test('dispatcher reads durable session tier rather than global defaults', async () => {
  let sent;
  const dispatcher = createCodexTurnDispatcher({
    store: { getLogicalSessionByLegacySessionId: () => null, clearActiveChoicePrompt() {},
      getSession: () => ({ external: { cwd: '/tmp', currentServiceTier: 'priority' } }) },
    bumpChoiceGeneration() {}, ensureCodexSessionPermissions: async s => s,
    sessionWithLogicalWorkspace: s => s, collaborationThreadOptionsForSession: async () => ({}),
    codexRuntime: { ensureThreadResumed: async () => ({}), startTurn: async (_id, _text, options) => {
      sent = options; return { turn: { id: 'turn' } };
    } }
  });
  await dispatcher.sendCodexProviderMessage({ sessionId: 's', providerSessionId: 't' }, 'hi');
  assert.equal(sent.serviceTier, 'priority');
});
