import { NewApiClient } from "./client";

type Env = Readonly<Record<string, string | undefined>>;

export type NewApiServiceConfig = Readonly<{
  env?: Env;
  baseUrl?: string;
  basePath?: string;
  adminToken?: string;
  adminTokenRef?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

export function createNewApiClient(config: NewApiServiceConfig = {}): NewApiClient | null {
  const env = config.env ?? process.env;
  const baseUrl = readSetting(config.baseUrl) ?? readSetting(env.NEWAPI_BASE_URL);
  const adminToken = readSetting(config.adminToken)
    ?? readSetting(config.adminTokenRef)
    ?? readSetting(env.NEWAPI_ADMIN_TOKEN_REF);

  if (!baseUrl || !adminToken) {
    return null;
  }

  return new NewApiClient({
    baseUrl,
    adminToken,
    basePath: config.basePath,
    timeoutMs: config.timeoutMs ?? parseTimeoutMs(env.NEWAPI_TIMEOUT_MS),
    fetchImpl: config.fetchImpl,
  });
}

function readSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}
