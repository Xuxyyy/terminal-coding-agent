import {MODELS, providerLabelOf} from './models.js';
import {ModelTimeoutError} from './client.js';

export type ExplainedError = {message: string; hint?: string};

const NO_BALANCE = /insufficient[ _](balance|quota)/i;

function statusOf(error: unknown): unknown {
  const {status, cause} = (error ?? {}) as {status?: unknown; cause?: unknown};
  if (status !== undefined) return status;
  return (cause as {status?: unknown})?.status;
}

function messageOf(error: unknown): string {
  const raw = (error as Error)?.message;
  return raw && raw.trim() ? raw : 'the request failed';
}

export function explainError(error: unknown, model: string): ExplainedError {
  const raw = messageOf(error);
  if (error instanceof ModelTimeoutError ||
    (error as Error)?.cause instanceof ModelTimeoutError) {
    return {message: raw, hint: 'try again, or check your Gemini connection'};
  }
  const provider = providerLabelOf(model);
  if (!provider) return {message: raw};

  const label = MODELS[model]?.label ?? model;
  const status = statusOf(error);

  if (status === 402 || NO_BALANCE.test(raw)) {
    return {
      message: `${provider} refused the request — your balance is empty`,
      hint: `top up your ${provider} account, or switch model with /model`,
    };
  }
  if (status === 429) {
    if (/requests? per day|\bdaily\b|\bRPD\b/i.test(raw)) {
      return {
        message: `${provider} daily limit reached for ${label}`,
        hint: 'wait for the daily reset at midnight Pacific, or choose another available model with /model',
      };
    }
    return {
      message: `${provider} rate limit — ${label} sent more requests than your plan allows`,
      hint: `switch model with /model, or raise your ${provider} plan`,
    };
  }
  return {message: raw};
}
