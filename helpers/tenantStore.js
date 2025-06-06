// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});

const DB  = "tenant-routing";
const COL = "items";
const container = client.database(DB).container(COL);

/**
 *  upsertTenant
 *  • READ the full doc (explicit partition key guarantees same partition)
 *  • If 404 → create minimal doc
 *  • Merge lastSeen onto whatever exists
 *  • UPSERT the merged doc (single write, keeps all fields)
 *  • Logs read / upsert result for debugging
 */
export async function upsertTenant (tenantId) {
  let doc;

  /* --- 1. READ --- */
  try {
    const { resource } = await container.item(tenantId, tenantId).read();
    doc = resource;
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
      throw err;
    }
    // First-ever chat: create minimal record
    doc = { id: tenantId };
    console.log("Creating new tenant record for", tenantId);
  }

  /* --- 2. MERGE timestamp (keeps secret fields) --- */
  doc.lastSeen = new Date().toISOString();

  /* --- 3. UPSERT --- */
  const { resource: merged } = await container.items.upsert(doc);
  console.log("DEBUG tenantRow →", JSON.stringify(merged));
  return merged;          // caller uses voiceflowSecret / version if present
}
