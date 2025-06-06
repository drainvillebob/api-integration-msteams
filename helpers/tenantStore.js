// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

// ──────────────────────────────────────────────
//  Cosmos client
// ──────────────────────────────────────────────
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY,
});

const DB  = "tenant-routing";
const COL = "items";
const container = client.database(DB).container(COL);

// ──────────────────────────────────────────────
//  upsertTenant  –  “touch but never clobber”
//  • read  → merge lastSeen → upsert
//  • read uses { consistencyLevel: "Strong" } so
//    we always see the latest write, even right
//    after a manual portal edit.
// ──────────────────────────────────────────────
export async function upsertTenant(tenantId) {
  let doc;

  /* -------- 1. READ (strong) -------- */
  try {
    const { resource } = await container
      .item(tenantId, tenantId)
      .read({ consistencyLevel: "Strong" });   // 👈 key change
    doc = resource;
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
      throw err;
    }
    // first-ever chat → minimal doc
    doc = { id: tenantId };
    console.log("Creating new tenant record for", tenantId);
  }

  /* -------- 2. MERGE timestamp -------- */
  doc.lastSeen = new Date().toISOString();

  /* -------- 3. UPSERT (single write) -------- */
  const { resource: merged } = await container.items.upsert(doc);
  console.log("DEBUG tenantRow →", JSON.stringify(merged));
  return merged;     // app.js uses voiceflowSecret / version from here
}
