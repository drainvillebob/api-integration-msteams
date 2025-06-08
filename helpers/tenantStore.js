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
  /* 1 ─ READ (default consistency) */
  let doc;
  try {
    const { resource } = await container
      .item(tenantId, tenantId)                 // explicit partition key
      .read();
    doc = resource;
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
      throw err;
    }
    // first-ever tenant chat ⇒ create skeleton doc
    doc = { id: tenantId };
    console.log("Creating new tenant record for", tenantId);
  }

  /* 2 ─ Merge timestamp */
  doc.lastSeen = new Date().toISOString();

  /* 3 ─ UPSERT with optimistic concurrency */
  try {
    const { resource: merged } = await container.items.upsert(doc, {
      accessCondition: {
        type: "IfMatch",
        condition: doc._etag ?? "*"   // "*" allows first insert
      }
    });
    console.log("DEBUG tenantRow →", JSON.stringify(merged));
    return merged;
  } catch (err) {
    if (err.code !== 412) throw err;  // re-throw anything but “Precondition Failed”

    /* 3a ─ 412 means we raced a newer portal save
       → re-read freshest doc, merge again, upsert */
    console.warn("412 race - reloading latest doc for", tenantId);
      const { resource: fresh } = await container
      .item(tenantId, tenantId)
      .read();

    fresh.lastSeen = new Date().toISOString();
    const { resource: merged } = await container.items.upsert(fresh, {
      accessCondition: { type: "IfMatch", condition: fresh._etag }
    });
    console.log("DEBUG tenantRow (retry) →", JSON.stringify(merged));
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
