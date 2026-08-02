import { NewApiClient, NewApiConnectorError } from "./connectors/newapi/client";
import { createNewApiClient } from "./connectors/newapi/service";
import {
  getModelPolicyInputSchema,
  getUsageSummaryInputSchema,
  listAvailableModelsInputSchema,
} from "./connectors/newapi/types";
import { createRouter, userQuery } from "./middleware";

type NewApiRouterResult<Data> =
  | Readonly<{ ok: true; data: Data }>
  | Readonly<{ ok: false; error: "newapi_not_configured" }>
  | Readonly<{ ok: false; error: "newapi_request_failed"; message: string }>;

export const newapiRouter = createRouter({
  listAvailableModels: userQuery
    .input(listAvailableModelsInputSchema.optional())
    .query(async ({ input }) => runNewApiRequest((client) => client.listAvailableModels(input ?? {}))),

  listModelChannels: userQuery.query(async () =>
    runNewApiRequest((client) => client.listModelChannels())
  ),

  getUsageSummary: userQuery
    .input(getUsageSummaryInputSchema.optional())
    .query(async ({ input }) => runNewApiRequest((client) => client.getUsageSummary(input ?? {}))),

  getChannelHealth: userQuery.query(async () =>
    runNewApiRequest((client) => client.getChannelHealth())
  ),

  getModelPolicy: userQuery
    .input(getModelPolicyInputSchema)
    .query(async ({ input }) => runNewApiRequest((client) => client.getModelPolicy(input))),
});

async function runNewApiRequest<Data>(
  operation: (client: NewApiClient) => Promise<Data>
): Promise<NewApiRouterResult<Data>> {
  const client = createNewApiClient();
  if (!client) {
    return { ok: false, error: "newapi_not_configured" };
  }

  try {
    return { ok: true, data: await operation(client) };
  } catch (error) {
    if (error instanceof NewApiConnectorError || error instanceof Error) {
      return { ok: false, error: "newapi_request_failed", message: error.message };
    }
    return { ok: false, error: "newapi_request_failed", message: "Unknown New API request failure" };
  }
}
