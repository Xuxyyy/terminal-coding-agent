export type Provider = {label: string; keyEnv: string};

export const PROVIDERS: Record<string, Provider> = {
  gemini: {label: 'Gemini', keyEnv: 'GEMINI_API_KEY'},
};

export type ModelInfo = {provider: string; label: string; contextWindow: number};

export const MODELS: Record<string, ModelInfo> = {
  'gemini-3.8-flash': {
    provider: 'gemini',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
  },
  'gemini-3.1-pro-preview': {
    provider: 'gemini',
    label: 'Gemini 3.1 Pro Preview',
    contextWindow: 1_048_576,
  },
  'gemini-3.5-flash-lite': {
    provider: 'gemini',
    label: 'Gemini 3.5 Flash-Lite',
    contextWindow: 1_048_576,
  },
};

export const JUDGE_MODELS: Record<string, string> = {
  gemini: 'gemini-3.5-flash-lite',
};

export const DEFAULT_MODEL = 'gemini-3.8-flash';

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
  return keyEnv ? Boolean(env.ACC_MODEL_RELAY_URL || env[keyEnv]) : false;
}
