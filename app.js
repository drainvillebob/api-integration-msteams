/**********************************************************************
 *  api-integration-msteams  –  multi-tenant edition
 *  ------------------------------------------------
 *  • Captures tenantId from every Teams message
 *  • Upserts / refreshes a tenant row in Cosmos DB (with user email)
 *  • Pulls Voiceflow API key + version from that row (fallback to env)
 *********************************************************************/

require('dotenv').config();
const process         = require('node:process');
const express         = require('express');
const axios           = require('axios').default;
const {
  BotFrameworkAdapter,
  MessageFactory,
  CardFactory,
  TeamsInfo, // <-- import TeamsInfo for member info
} = require('botbuilder');
const localtunnel      = require('localtunnel');
const { upsertTenant, getTenantConfig } = require('./helpers/tenantStore');

/* ──────────────────────────────────────────────
   Voiceflow Dialog Manager options
─────────────────────────────────────────────── */
const DMconfig = { tts: false, stripSSML: false };

/* ──────────────────────────────────────────────
   Web server
─────────────────────────────────────────────── */
const app    = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let tunnel;
if (process.env.NODE_ENV !== 'production' && process.env.TUNNEL_SUBDOMAIN) {
  (async () => {
    tunnel = await localtunnel({
      port: process.env.PORT || 3978,
      subdomain: process.env.TUNNEL_SUBDOMAIN
    });
    console.log(`LocalTunnel running at ${tunnel.url}`);
  })();
}

/* ──────────────────────────────────────────────
   Bot adapter
─────────────────────────────────────────────── */
const adapter = new BotFrameworkAdapter({
  appId:
    process.env.MicrosoftAppId ||
    process.env.MICROSOFT_APP_ID,
  appPassword:
    process.env.MicrosoftAppPassword ||
    process.env.MICROSOFT_APP_PASSWORD,
});

/* Global error handler */
adapter.onTurnError = async (context, error) => {
  console.error('[onTurnError] unhandled error:', error);
  await context.sendTraceActivity('OnTurnError Trace', `${error}`, 'https://www.botframework.com/schemas/error', 'TurnError');
  await context.sendActivity('The bot encountered an error or bug.');
  await context.sendActivity('To continue to run this bot, please fix the bot source code.');
};

/* ──────────────────────────────────────────────
   Incoming requests → /api/messages
─────────────────────────────────────────────── */
app.post('/api/messages', (req, res) => {
  adapter.processActivity(req, res, async (turnContext) => {
    if (turnContext.activity.type !== 'message') return;

    const user_id   = turnContext.activity.from.id;
    const utterance = turnContext.activity.text || '';

    /* ---------- 1. Capture + store tenant ---------- */
    const tenantId =
      turnContext.activity.conversation?.tenantId ||
      turnContext.activity.channelData?.tenant?.id ||
      (turnContext.turnState.get('httpHeaders') || {})['x-ms-tenant-id'] ||
      'unknown-tenant';

    const companyName =
      turnContext.activity.channelData?.team?.name ||
      turnContext.activity.conversation?.name ||
      process.env.COMPANY_NAME ||
      'unknown-company';

    // ------ NEW: Try to fetch user's email from Teams -------
    let userEmail = null;
    try {
      const member = await TeamsInfo.getMember(turnContext, user_id);
      userEmail = member.email || member.userPrincipalName || null;
    } catch (err) {
      console.warn('Could not fetch Teams user email:', err.message);
    }

    // Pass userEmail to upsertTenant!
    const tenantRow = await upsertTenant(tenantId, user_id, companyName, userEmail);  // creates or refreshes

    /* ---------- 2. Resolve Voiceflow creds ---------- */
    const vfKey     = tenantRow.voiceflowSecret  || process.env.VOICEFLOW_API_KEY;
    const vfVersion = tenantRow.voiceflowVersion || process.env.VOICEFLOW_VERSION;

    /* ---------- 3. Voiceflow integration ---------- */
    const payload = {
      userID: user_id,
      sessionID: tenantId,
      action: {
        type: 'text',
        payload: utterance,
      },
      config: DMconfig,
      state: {},
    };

    try {
      const vfResponse = await axios.post(
        `${process.env.VOICEFLOW_RUNTIME_ENDPOINT || 'https://general-runtime.voiceflow.com'}/state/${vfVersion}/interact`,
        payload,
        {
          headers: {
            Authorization: vfKey,
            'Content-Type': 'application/json',
          },
        }
      );
      const messages = vfResponse.data || [];
      await sendMessage(messages, turnContext);
    } catch (err) {
      console.error('[Voiceflow] Error:', err.message);
      await turnContext.sendActivity("Sorry, I couldn't process your request right now.");
    }
  });
});

/* ──────────────────────────────────────────────
   Helper to send Voiceflow response to Teams
─────────────────────────────────────────────── */
async function sendMessage(messages, turnContext) {
  for (const msg of messages) {
    let activity = null;

    if (msg.type === 'image') {
      activity = MessageFactory.attachment(CardFactory.heroCard(null, [msg.value]));
    } else if (msg.type === 'buttons') {
      const actions = msg.buttons.map(b => b.label);
      activity = MessageFactory.attachment(CardFactory.heroCard(null, null, actions));
    } else if (msg.type === 'text') {
      activity = msg.value;
    }

    if (activity) await turnContext.sendActivity(activity);
  }
}

/* ──────────────────────────────────────────────
   Start server
─────────────────────────────────────────────── */
const port = process.env.PORT || 3978;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

module.exports = app;
