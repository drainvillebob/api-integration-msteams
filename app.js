/**********************************************************************
 *  api-integration-msteams  –  multi-tenant edition
 *  ------------------------------------------------
 *  • Captures tenantId from every Teams message
 *  • Upserts / refreshes a tenant row in Cosmos DB
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
const server = app.listen(process.env.PORT || 3978, async () => {
  const { port } = server.address();
  console.log('\nServer listening on port %d in %s mode', port, app.settings.env);

  /* dev-only localtunnel helper */
  if (app.settings.env === 'development') {
    const tunnel = await localtunnel({
      port,
      subdomain: process.env.TUNNEL_SUBDOMAIN,
    });
    console.log(`\nEndpoint: ${tunnel.url}/api/messages`);
    console.log('Get Bot Framework Emulator: https://aka.ms/botframework-emulator');
    tunnel.on('close', () => console.log('\nClosing tunnel'));
  }
  console.log('');

  /* Optional spinner — run only when stdout is a TTY (avoids Azure crash) */
  if (process.stdout.isTTY && process.stdout.clearLine) {
    let i = 0;
    setInterval(() => {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      i = (i + 1) % 4;
      process.stdout.write('Listening' + '.'.repeat(i));
    }, 300);
  }
});

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

    const tenantRow = await upsertTenant(tenantId, user_id, companyName);  // creates or refreshes

    /* ---------- 2. Resolve Voiceflow creds ---------- */
    const vfKey     = tenantRow.voiceflowSecret  || process.env.VOICEFLOW_API_KEY;
    const vfVersion = tenantRow.voiceflowVersion || process.env.VOICEFLOW_VERSION;
    console.log("DEBUG tenantRow =", JSON.stringify(tenantRow));
    console.log("DEBUG chosen vfKey =", vfKey);
    console.log("DEBUG chosen vfVersion =", vfVersion);

    /* ---------- 3. Voiceflow interaction ---------- */
    const vfResponses = await interact(
      user_id,
      { type: 'text', payload: utterance },
      vfKey,
      vfVersion
    );

    if (vfResponses.length) {
      await sendMessage(vfResponses, turnContext);
    }
  });
});

/* ──────────────────────────────────────────────
   Voiceflow helper functions
─────────────────────────────────────────────── */
async function interact(user_id, request, vfKey, vfVersion) {
  /* 1) update variables */
  await axios.patch(
    `${process.env.VOICEFLOW_RUNTIME_ENDPOINT}/state/user/${encodeURI(user_id)}/variables`,
    { user_id },
    {
      headers: {
        Authorization: vfKey,
        'Content-Type': 'application/json',
      },
    }
  );

  /* 2) send interact request */
  const { data } = await axios.post(
    `${process.env.VOICEFLOW_RUNTIME_ENDPOINT}/state/user/${encodeURI(user_id)}/interact`,
    {
      action: request,
      config: DMconfig,
    },
    {
      headers: {
        Authorization: vfKey,
        'Content-Type': 'application/json',
        versionID: vfVersion,
      },
    }
  );

  /* 3) translate VF response → simplified array */
  const outputs = [];

  for (const step of data) {
    if (step.type === 'text') {
      let speech = '';
      for (const block of step.payload.slate.content) {
        for (const child of block.children) {
          if (child.type === 'link')                speech += child.url;
          else if (child.text && child.fontWeight)  speech += `**${child.text}**`;
          else if (child.text && child.italic)      speech += `_${child.text}_`;
          else if (child.text && child.underline)   speech += child.text;
          else if (child.text && child.strikeThrough) speech += `~${child.text}~`;
          else if (child.text)                      speech += child.text;
        }
        speech += '\n';
      }
      outputs.push({ type: 'text', value: speech });

    } else if (step.type === 'visual') {
      outputs.push({ type: 'image', value: step.payload.image });

    } else if (step.type === 'choice') {
      const buttons = step.payload.buttons.map(b => ({ label: b.request.payload.label }));
      outputs.push({ type: 'buttons', buttons });
    }
  }

  if (data.some(({ type }) => type === 'end')) console.log('Convo ended');
  return outputs;
}

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
   Graceful shutdown
─────────────────────────────────────────────── */
process.on('SIGINT', () => process.exit());
process.on('exit', () => console.log('Bye!\n'));
