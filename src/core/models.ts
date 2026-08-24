export type Provider = {label: string; baseUrl: string; keyEnv: string};

export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  glm: {
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4/',
    keyEnv: 'GLM_API_KEY',
  },
  kimi: {
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: 'MOONSHOT_API_KEY',
  },
};

export type ModelInfo = {provider: string; label: string; contextWindow: number};

export const MODELS: Record<string, ModelInfo> = {
  'kimi-k3': {provider: 'kimi', label: 'Kimi K3', contextWindow: 262_144},
  'kimi-k2.7-code': {
    provider: 'kimi',
    label: 'Kimi K2.7 Code',
    contextWindow: 262_144,
  },
  'deepseek-v4-pro': {
    provider: 'deepseek',
    label: 'DeepSeek v4 Pro',
    contextWindow: 262_144,
  },
  'deepseek-v4-flash': {
    provider: 'deepseek',
    label: 'DeepSeek v4 Flash',
    contextWindow: 262_144,
  },
  'glm-5.2': {provider: 'glm', label: 'GLM 5.2', contextWindow: 262_144},
  'glm-4.7-flash': {
    provider: 'glm',
    label: 'GLM 4.7 Flash',
    contextWindow: 200_000,
  },
};

export const JUDGE_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  kimi: 'kimi-k2.7-code',
  glm: 'glm-4.7-flash',
};

export const DEFAULT_MODEL = 'deepseek-v4-flash';

export const MODEL_IDS = Object.keys(MODELS);

export function providerLabelOf(id: string): string | null {
  const info = MODELS[id];
  return info ? (PROVIDERS[info.provider]?.label ?? null) : null;
}

export function keyEnvOf(id: string): string | null {
  const info = MODELS[id];
  return info ? (PROVIDERS[info.provider]?.keyEnv ?? null) : null;
}

export function hasKey(id: string, env: NodeJS.ProcessEnv): boolean {
  const keyEnv = keyEnvOf(id);
  return keyEnv ? Boolean(env[keyEnv]) : false;
}
