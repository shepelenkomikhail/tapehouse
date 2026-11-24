function read(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  // Tolerate values pasted with surrounding quotes.
  return value.replace(/^(['"])(.*)\1$/, "$2").trim() || undefined;
}

export function getEnv() {
  return {
    botToken: read("TELEGRAM_BOT_TOKEN"),
    botUsername: read("TELEGRAM_BOT_USERNAME")?.replace(/^@/, ""),
    webhookSecret: read("TELEGRAM_WEBHOOK_SECRET"),
    /** Signs stream links; independent of the bot token so the token can be rotated. */
    signingSecret: read("TAPEHOUSE_SIGNING_SECRET"),
    appUrl: read("PUBLIC_APP_URL") ?? "http://localhost:3000",
    /**
     * Local-only escape hatch so the Mini App can be previewed in a normal browser.
     * Format: "<telegram user id>:<first name>". Ignored on Vercel production.
     */
    devUser: process.env.VERCEL_ENV === "production" ? undefined : read("TAPEHOUSE_DEV_USER"),
    /** Optional: enables Jamendo in "Find music" (free key from devportal.jamendo.com). */
    jamendoClientId: read("JAMENDO_CLIENT_ID"),
    /** Separates prod/preview/dev data inside the single Blob store. */
    dataPrefix: process.env.VERCEL_ENV ?? "development",
  };
}

export function requireBotToken() {
  const token = getEnv().botToken;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }
  return token;
}
