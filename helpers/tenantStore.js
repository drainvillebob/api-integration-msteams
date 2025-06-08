// helpers/tenantStore.js
const { CosmosClient } = require("@azure/cosmos");

/* ───────── Cosmos client ───────── */
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});
const container = client
  .database("tenant-routing")
  .container("items");

/* ───────── upsertTenant ───────── */
/**
 * • READ using the account's consistency level
 * • If first chat, create minimal doc
 * • Merge lastSeen
 * • UPSERT with IfMatch so we never clobber
 *   a newer version written in the portal
 * • On 412, re-read freshest doc, merge, upsert again
 */
async function upsertTenant (tenantId) {
  let doc;
  try {
    const { resource } = await container
      .item(tenantId, tenantId)
      .read();
    doc = resource;
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
      throw err;
    }
    doc = { id: tenantId };
    console.log("Creating new tenant record for", tenantId);
  }

  doc.lastSeen = new Date().toISOString();

  try {
    const { resource: merged } = await container.items.upsert(doc, {
      accessCondition: {
        type: "IfMatch",
        condition: doc._etag ?? "*"
      }
    });
    return merged;
  } catch (err) {
    if (err.code !== 412) throw err;
    console.warn("412 race - reloading latest doc for", tenantId);
    const { resource: fresh } = await container
      .item(tenantId, tenantId)
      .read();

    fresh.lastSeen = new Date().toISOString();
    const { resource: merged } = await container.items.upsert(fresh, {
      accessCondition: { type: "IfMatch", condition: fresh._etag }
    });
    return merged;
  }
}

async function getTenantConfig (tenantId) {
  try {
    const { resource } = await container
      .item(tenantId, tenantId)
      .read();
    return resource;
  } catch {
    return null; // not found
  }
}

module.exports = {
  upsertTenant,
  getTenantConfig,
};
