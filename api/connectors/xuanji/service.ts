import { z } from "zod";
import { XuanjiConnectorClient, type FetchImplementation } from "./client";

const TimeoutMsSchema = z.union([
  z.number().int().positive(),
  z.string().trim().regex(/^\d+$/).transform((value) => Number(value)),
]);

const XuanjiClientFactoryConfigSchema = z.object({
  baseUrl: z.string().trim().optional(),
  apiKeyRef: z.string().trim().optional(),
  timeoutMs: TimeoutMsSchema.optional(),
  fetchImpl: z.custom<FetchImplementation>((value) => typeof value === "function").optional(),
});

export type XuanjiClientFactoryConfig = Readonly<z.infer<typeof XuanjiClientFactoryConfigSchema>>;

export function createXuanjiClient(
  config: XuanjiClientFactoryConfig = {}
): XuanjiConnectorClient | null {
  const parsed = XuanjiClientFactoryConfigSchema.parse({
    baseUrl: config.baseUrl ?? process.env.XUANJI_BASE_URL,
    apiKeyRef: config.apiKeyRef ?? process.env.XUANJI_API_KEY_REF,
    timeoutMs: config.timeoutMs ?? process.env.XUANJI_TIMEOUT_MS,
    fetchImpl: config.fetchImpl,
  });

  if (!parsed.baseUrl) {
    return null;
  }

  return new XuanjiConnectorClient({
    baseUrl: parsed.baseUrl,
    apiKey: parsed.apiKeyRef ?? "",
    timeoutMs: parsed.timeoutMs,
    fetchImpl: parsed.fetchImpl,
  });
}
