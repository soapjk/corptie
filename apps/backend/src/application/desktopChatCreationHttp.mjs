// Desktop bridge to the existing receipt-backed, Provider-neutral chat creator.
// Keep uncertain outcomes in that journal; never repeat a launch to recover a response.
export function handleDesktopChatCreation({ request, response, url, api, store, readJson, sendJson }) {
  if (url.pathname !== '/desktop/chats/create') return false;
  const identity = () => {
    if (request.headers.origin || request.headers['x-corptie-agent-id']
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      throw Object.assign(new Error('LOCAL_USER_REQUIRED'), { code: 'LOCAL_USER_REQUIRED', status: 403 });
    }
    return { kind: 'local_user', principalId: 'local-user' };
  };
  void (async () => {
    try {
      identity();
      if (request.method !== 'POST') throw Object.assign(new Error('METHOD_NOT_ALLOWED'), { status: 405 });
      if (!api) throw Object.assign(new Error('CAPABILITY_UNAVAILABLE'), { status: 503 });
      const receipt = await api.createChat(identity(), await readJson(request), identity);
      const id = receipt.entityResult?.sessionId;
      sendJson(response, 200, { receipt, session: id ? store.getSession(id) : null });
    } catch (error) {
      sendJson(response, error.status ?? error.statusCode ?? 500,
        { error: 'Could not create chat. Check creation status before retrying.', code: error.code ?? 'CHAT_CREATION_FAILED' });
    }
  })();
  return true;
}
