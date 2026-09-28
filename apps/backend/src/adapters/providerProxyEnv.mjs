export function proxyEnvForProfile(profile = {}) {
  if (!profile?.enabled) return {};
  const env = {};
  setProxyEnvValue(env, "HTTP_PROXY", profile.httpProxy);
  setProxyEnvValue(env, "HTTPS_PROXY", profile.httpsProxy);
  setProxyEnvValue(env, "ALL_PROXY", profile.allProxy);
  setProxyEnvValue(env, "NO_PROXY", profile.noProxy);
  return env;
}

function setProxyEnvValue(env, key, value) {
  if (typeof value !== "string" || !value.trim()) return;
  env[key] = value.trim();
  env[key.toLowerCase()] = value.trim();
}
