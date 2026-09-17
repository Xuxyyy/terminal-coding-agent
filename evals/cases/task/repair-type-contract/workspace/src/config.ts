export type RuntimeConfig = {
  host: string;
  port: number;
};

export function runtimeConfig(
  env: Record<string, string | undefined>,
): RuntimeConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: env.PORT ?? 3000,
  };
}
