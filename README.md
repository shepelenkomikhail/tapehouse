# Tapehouse

A Telegram Mini App + bot that gives Telegram music real playlists: collect tracks, sort them into
playlists, reorder, smart-shuffle, play them in the app, or send them back to a chat for Telegram's
own player. Works on phone and desktop Telegram. Your Telegram account is your login.

Live: https://tapehouse.shepelenkomykhailo.com · Bot: [@tapehouse_bot](https://t.me/tapehouse_bot)

## How it works

```
 you ──forward audio──▶ bot (webhook, /api/telegram-webhook)
                          │ stores file_id + title in your inbox (Vercel Blob)
                          ▼
 Mini App opens ──▶ /api/inbox (signed Telegram initData) ──▶ moves tracks into
                    your "Inbox" playlist in Telegram CloudStorage, then clears the server inbox
 play ──▶ /api/stream?f=<file_id>&s=<sig>  (proxies audio from Telegram, hides the bot token)
 send to chat ──▶ /api/send  (bot re-sends the tracks to you as audio albums)
 group playlists ──▶ /api/group?chat=<id>  (Blob; membership checked with Telegram on every call)
```

Audio never leaves Telegram's servers; we only keep `file_id`s and titles.

| Data | Where | Why |
|---|---|---|
| Personal playlists | Telegram CloudStorage (per user, synced across devices) | Free, no write limits, nothing stored by us |
| Bot inbox (tracks waiting to be picked up) | Vercel Blob, private store `tapehouse-data` | The bot can't write to a user's CloudStorage |
| Group playlists | Vercel Blob | Shared between members |

Blob paths are prefixed by environment (`production/`, `preview/`, `development/`). Hobby plan Blob
allows 2,000 writes/month; with this split, writes happen only when the bot receives a track or a
group playlist changes.

## Auth

- Every API call sends `Authorization: tma <initData>`. The server checks Telegram's HMAC signature
  with the bot token and rejects data older than 7 days (`server/lib/telegram-auth.ts`).
- Group endpoints additionally call `getChatMember` (cached 5 min).
- Stream URLs carry an HMAC of the `file_id`, because `<audio>` can't send headers.
- The webhook is authenticated by Telegram's `X-Telegram-Bot-Api-Secret-Token`.

## Project layout

```
api/            Vercel functions: inbox, group, stream, send, telegram-webhook, health
server/         bot handlers, Telegram API client, Blob document store, auth
shared/         types + pure playlist operations used by both client and server
src/            React Mini App (CloudStorage library, player, UI)
scripts/        setup-telegram.mjs: webhook, commands, menu button
```

## Bot usage

- **Private chat:** send or forward any audio (or an mp3/m4a/flac file) to the bot. It goes to your Inbox.
- **Groups:** reply `/save@tapehouse_bot` to a track to add it to the group's shared playlist, or
  `/inbox@tapehouse_bot` to keep it for yourself. Captioning an upload with `@tapehouse_bot`
  also works if the bot can see group messages (privacy mode off).

## Limits

- Telegram's Bot API can't fetch files over **20 MB**, so those can't stream in the app.
  "Send to chat" still works for them (it re-sends by `file_id`).
- On phones the in-app player stops when Telegram closes the Mini App. For long listening, use
  "Send to chat" and Telegram's own player.

## Development

```bash
npm install
npx vercel@latest env pull .env.local       # Blob credentials
npm run check                               # typecheck client + API
npx vercel@latest dev --listen 3000         # app + functions on http://localhost:3000
```

`vercel dev` reads `.env` for local settings. Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`BLOB_READ_WRITE_TOKEN` and `TAPEHOUSE_DEV_USER="1:Local"` there (see `.env.example`).
`TAPEHOUSE_DEV_USER` lets a normal browser act as that Telegram user; it's ignored in production.
Outside Telegram the app saves playlists to localStorage instead of CloudStorage.

## Deploy

```bash
npx vercel@latest deploy --prod
node --env-file=.env.production.local scripts/setup-telegram.mjs   # after `vercel env pull .env.production.local --environment=production`
```

Production env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`,
`TAPEHOUSE_SIGNING_SECRET` (signs stream links; keep it stable), `PUBLIC_APP_URL`, plus `BLOB_READ_WRITE_TOKEN` (added when the Blob store was connected).

One-time BotFather setup: enable the Main Mini App with the app URL, and `/setdomain` to the app host.
