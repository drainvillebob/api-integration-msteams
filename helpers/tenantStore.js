// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

// ──────────────────────────────────────────────
//  Cosmos client setup
// ──────────────────────────────────────────────
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});

const DB  = "tenant-routing";
const COL = "items";
const container = client.database(DB).container(COL);

// ──────────────────────────────────────────────
//  upsertTenant — safe “touch” update
//  1. PATCH /lastSeen  (does NOT overwrite doc)
//  2. READ full doc    (returns all existing fields)
//  Logs any Cosmos error codes for easy tracing
// ──────────────────────────────────────────────
export async function upsertTenant (tenantId) {
  // #1  PATCH lastSeen (ignore 404 if first-time tenant)
  try {
    await container
      .item(tenantId)                       // SDK infers partition key (/id)
      .patch([{ op: "add", path: "/lastSeen", value: new Date().toISOString() }]);
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS PATCH ERROR →", err.code);
      throw err;                            // only re-throw unexpected errors
    }
  }

  // #2  READ the full document (may still be 404 on very first chat)
  let resource = {};
  try {
    ({ resource } = await container.item(tenantId).read());
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code);
      throw err;
    }
    // create a minimal doc so future PATCH & READ succeed
    resource = {
      id: tenantId,
      lastSeen: new Date().toISOString()
    };
    await container.items.create(resource);
  }

  return resource;
}
