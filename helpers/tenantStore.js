// helpers/tenantStore.js
const { CosmosClient } = require("@azure/cosmos");
const nodemailer = require("nodemailer");

/* ───────── Mailer setup ───────── */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

async function notifyNewTenant(tenantId, userId, companyName) {
  if (!process.env.SMTP_HOST) return; // skip if not configured
  const mail = {
    from: process.env.SMTP_FROM || 'noreply@example.com',
    to: 'info@askchatbots',
    subject: `New tenant added: ${tenantId}`,
    text: `A new tenant was created.\nTenant ID: ${tenantId}\nUser ID: ${userId}\nCompany: ${companyName}`,
  };
  try {
    await transporter.sendMail(mail);
  } catch (err) {
    console.error('Email send failed', err.message);
  }
}

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
async function upsertTenant (tenantId, userId, companyName) {
  /* 1 ─ READ (default consistency) */
  let doc;
  let isNew = false;
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
    doc = { id: tenantId, userId, companyName };
    isNew = true;
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
    if (isNew) await notifyNewTenant(tenantId, userId, companyName);
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
