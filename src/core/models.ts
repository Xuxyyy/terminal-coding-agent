export type Provider = {label: string; keyEnv: string};

export const PROVIDERS: Record<string, Provider> = {
  deepseek: {label: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY'},
};

export type ModelInfo = {provider: string; label: string; contextWindow: number};

export const MODELS: Record<string, ModelInfo> = {
  'deepseek-flash': {
    provider: 'deepseek',
    label: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
  },
};

export const JUDGE_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_MODEL = 'deepseek-flash';
export const LEGACY_GEMINI_MODELS = new Set([
  'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite',
]);
export const REASONING_EFFORTS = ['none', 'low', 'high', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

export function migratedModel(id: string): string {
  return LEGACY_GEMINI_MODELS.has(id) ? DEFAULT_MODEL : id;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

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
