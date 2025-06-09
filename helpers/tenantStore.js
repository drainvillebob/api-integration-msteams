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

async function notifyNewTenant(tenantId, userId, companyName, userEmail) {
  if (!process.env.SMTP_HOST) return; // skip if not configured
  const mail = {
    from: process.env.SMTP_FROM || 'noreply@example.com',
    to: 'info@askchatbots',
    subject: `New tenant added: ${tenantId}`,
    text: `A new tenant was created.\nTenant ID: ${tenantId}\nUser ID: ${userId}\nCompany: ${companyName}\nUser Email: ${userEmail || "N/A"}`,
  };
  try {
    await transporter.sendMail(mail);
  } catch (err) {
    console.error('Email send failed', err.message);
  }
}

/* ───────── Cosmos client (tenant-routing) ───────── */
const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});
const container = client
  .database("tenant-routing")
  .container("items");

/* ───────── Cosmos client (rag-meta) ───────── */
const ragMetaClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key:      process.env.COSMOS_KEY
});
const ragMetaContainer = ragMetaClient
  .database("rag-meta")
  .container("items");

/* ───────── addOrUpdateTenantInRagMeta ───────── */
async function addOrUpdateTenantInRagMeta(tenantId, lastSeen, userId, companyName, userEmail, voiceflowSecret, voiceflowVersion) {
  try {
    let existing;
    try {
      const { resource } = await ragMetaContainer.item(tenantId, tenantId).read();
      existing = resource;
    } catch (err) {
      if (err.code !== 404) throw err;
    }
    let doc;
    if (existing) {
      doc = {
        ...existing,
        lastSeen,
        userId: userId || existing.userId,
        companyName: companyName || existing.companyName,
        email: userEmail || existing.email,
        voiceflowSecret: voiceflowSecret || existing.voiceflowSecret,
        voiceflowVersion: voiceflowVersion || existing.voiceflowVersion,
      };
    } else {
      doc = {
        id: tenantId,
        lastSeen,
        userId,
        companyName,
        email: userEmail,
        voiceflowSecret,
        voiceflowVersion,
      };
    }
    await ragMetaContainer.items.upsert(doc);
    console.log("Upserted tenant in rag-meta:", tenantId);
  } catch (err) {
    console.error("Failed to upsert tenant in rag-meta:", err.message);
  }
}

/* ───────── upsertTenant ───────── */
async function upsertTenant (tenantId, userId, companyName, userEmail) {
  let doc;
  let isNew = false;
  try {
    const { resource } = await container
      .item(tenantId, tenantId)
      .read();
    doc = resource;
    if (!doc) {
      doc = { id: tenantId, userId, companyName };
      isNew = true;
      console.log("Creating new tenant record for", tenantId);
    }
  } catch (err) {
    if (err.code !== 404) {
      console.error("COSMOS READ ERROR →", err.code, "tenantId =", tenantId);
      throw err;
    }
    doc = { id: tenantId, userId, companyName };
    isNew = true;
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
    // Always upsert to rag-meta, passing all available fields
    await addOrUpdateTenantInRagMeta(
      tenantId,
      doc.lastSeen,
      doc.userId,
      doc.companyName,
      userEmail,
      doc.voiceflowSecret,
      doc.voiceflowVersion
    );
    if (isNew) {
      await notifyNewTenant(tenantId, userId, companyName, userEmail);
    }
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
    await addOrUpdateTenantInRagMeta(
      tenantId,
      fresh.lastSeen,
      fresh.userId,
      fresh.companyName,
      userEmail,
      fresh.voiceflowSecret,
      fresh.voiceflowVersion
    );
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
