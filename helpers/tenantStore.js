// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

// ──────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});

const DB_ID  = "tenant-routing";
const COL_ID = "items";
const container = client.database(DB_ID).container(COL_ID);

// ──────────────────────────────────────────────
//  upsertTenant
//  • keeps voiceflowSecret / voiceflowVersion
//  • refreshes lastSeen on every call
//  • logs 404 / 401 / 403 to help debug partition-key issues
// ──────────────────────────────────────────────
export async function upsertTenant(tenantId) {
  let existing = {};

  try {
    // Read existing doc (let SDK infer partition key by omitting 2nd arg)
    const { resource } = await container.item(tenantId).read();
    existing = resource || {};
  } catch (err) {
    // 🔎 DEBUG: log the Cosmos error code (appears in App-Service Log stream)
    console.error("COSMOS READ ERROR →", err.code);    // 404, 401, 403, etc.
    if (err.code !== 404) throw err;                   // bubble up real errors
  }

  // Merge timestamp onto whatever fields already exist
  const merged = {
    ...existing,               // keeps voiceflowSecret & voiceflowVersion
    id: tenantId,
    lastSeen: new Date().toISOString()
  };

  // Upsert (create if absent, replace if present)
  const { resource } = await container.items.upsert(merged);
  return resource;
}
