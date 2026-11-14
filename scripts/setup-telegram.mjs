// Points the bot at the deployed app: webhook, commands and the chat menu button.
// Usage: node --env-file=.env.production.local scripts/setup-telegram.mjs
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const appUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

for (const [name, value] of Object.entries({ TELEGRAM_BOT_TOKEN: token, PUBLIC_APP_URL: appUrl, TELEGRAM_WEBHOOK_SECRET: secret })) {
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and -.");
  process.exit(1);
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`${method}: ${result.description}`);
  }
  return result.result;
}

const me = await telegram("getMe");

await telegram("setWebhook", {
  url: `${appUrl}/api/telegram-webhook`,
  secret_token: secret,
  allowed_updates: ["message"],
  // One update at a time keeps inbox/group writes ordered.
  max_connections: 1,
});

await telegram("setMyCommands", {
  scope: { type: "all_private_chats" },
  commands: [
    { command: "start", description: "Open Tapehouse" },
    { command: "help", description: "How to collect tracks" },
  ],
});

await telegram("setMyCommands", {
  scope: { type: "all_group_chats" },
  commands: [
    { command: "save", description: "Reply to a track to add it to the group playlist" },
    { command: "inbox", description: "Reply to a track to save it to your Inbox" },
    { command: "help", description: "How Tapehouse works in groups" },
  ],
});

await telegram("setChatMenuButton", {
  menu_button: { type: "web_app", text: "Playlists", web_app: { url: appUrl } },
});

await telegram("setMyShortDescription", {
  short_description: "Playlists for your Telegram music: sort, reorder, shuffle and play.",
});

const info = await telegram("getWebhookInfo");
console.log(`Bot @${me.username} configured.`);
console.log(`Webhook: ${info.url} (pending updates: ${info.pending_update_count})`);
if (info.last_error_message) {
  console.log(`Last webhook error: ${info.last_error_message}`);
}
console.log(
  [
    "",
    "Finish in @BotFather (one time):",
    `  1. /mybots → @${me.username} → Bot Settings → Configure Mini App → Enable Mini App → ${appUrl}`,
    "     (this is the \"Main Mini App\"; group buttons use t.me links that open it)",
    `  2. /setdomain → @${me.username} → ${new URL(appUrl).host}`,
  ].join("\n"),
);
