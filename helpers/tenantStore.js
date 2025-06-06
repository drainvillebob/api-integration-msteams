// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

// ──────────────────────────────────────────────
//  Cosmos client
// ──────────────────────────────────────────────
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});

const DB  = "tenant-routing";
const COL = "items";
const container = client.database(DB).container(COL);

// ──────────────────────────────────────────────
//  upsertTenant  –  “touch but never clobber”
//  • First PATCH /lastSeen   (cheap, preserves other fields)
//  • Then READ the full doc  (returns voiceflowSecret / version)
//  • If READ still 404 → create minimal doc once
//  • Debug lines show 404 / 401 and chosen document
// ──────────────────────────────────────────────
export async function upsertTenant (tenantId) {
  /* -------------------------------------------
     1) Update timestamp only  (cheap RU/s)
  --------------------------------------------*/
  try {
    await container
      // explicit partitionKey value guarantees the correct logical partition
      .item(tenantId, tenantId)
      .patch([
        { op: "add", path: "/lastSeen", value: new Date().toISOString() }
      ]);
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS PATCH ERROR →", err.code);
      throw err;                     // unknown error – bubble up
    }
  }

  /* -------------------------------------------
     2) Read full document
  --------------------------------------------*/
  let resource = {};
  try {
    const resp = await container.item(tenantId, tenantId).read();
    resource = resp.resource || {};
  } catch (err) {
    console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
    if (err.code !== 404) throw err; // only ignore 'not found'
  }

  /* -------------------------------------------
     3) If it's the very first chat, create the doc
  --------------------------------------------*/
  if (!resource.id) {
    resource = {
      id: tenantId,
      lastSeen: new Date().toISOString()
      // voiceflowSecret & voiceflowVersion will be added later in portal
    };

    console.log("Creating initial tenant doc for", tenantId);
    await container.items.create(resource);
  }

  /* -------------------------------------------
     4) Return whatever we have (full doc)
  --------------------------------------------*/
  console.log("DEBUG tenantRow →", JSON.stringify(resource));
  return resource;
}
