// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_ENDPOINT;   // Function App settings
const key      = process.env.COSMOS_KEY;

const DB_ID  = "tenant-routing";
const COL_ID = "items";

const client = new CosmosClient({ endpoint, key });

export async function upsertTenant(tenantId, displayName = "Unknown") {
  const c = client.database(DB_ID).container(COL_ID);
  await c.items.upsert({
    id: tenantId,         // partition key = id for simplicity
    tenantName: displayName,
    lastSeen: new Date().toISOString()
  });
}
