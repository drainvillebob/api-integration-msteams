// helpers/tenantStore.js
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_ENDPOINT;
const key      = process.env.COSMOS_KEY;

const DB_ID  = "tenant-routing";
const COL_ID = "items";

const client = new CosmosClient({ endpoint, key });
const container = client.database(DB_ID).container(COL_ID);

/**
 * Upsert without clobbering existing fields.
 * Keeps voiceflowSecret & voiceflowVersion if they are present.
 */
export async function upsertTenant(tenantId) {
  // Try to read the existing doc (ignore 404)
  let existing = {};
  try {
    const { resource } = await container.item(tenantId, tenantId).read();
    existing = resource || {};
  } catch (err) {
    if (err.code !== 404) throw err;
  }

  // Merge lastSeen onto previous fields
  const merged = {
    ...existing,
    id: tenantId,
    lastSeen: new Date().toISOString()
  };

  // Upsert
  const { resource } = await container.items.upsert(merged);
  return resource;
}
