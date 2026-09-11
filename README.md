# Telegram Access Control Bot v3

Cloudflare Workers + D1 + Telegram Webhook edition.

## What it does

- Locks administration to `BOT_OWNER_ID` plus controller IDs you add.
- Keeps a whitelist of authorized Telegram supergroups.
- Announces the group ID when added.
- Automatically makes new normal members read-only.
- Lets selected normal members send using `/allow`.
- Makes them read-only again using `/block`.
- Supports reply-to-message `/allow` and `/block`.
- Deletes Telegram "joined the group" service messages.
- Strict mode catches older unapproved members when they try to post.
- Stores settings and member IDs in Cloudflare D1.
- Supports global and group-specific bot controllers.
- Validates Telegram webhook requests with `TELEGRAM_WEBHOOK_SECRET`.
- Protects webhook setup endpoints with a separate `SETUP_SECRET`.

## Telegram group configuration

The bot must be an admin with:

- Delete Messages
- Ban/Restrict Members

For selective sending, Telegram's global:

`Group -> Permissions -> Send Messages`

must be **ON**.

Do not globally disable Send Messages. The bot handles individual restrictions.

## Production secrets

Create these as Cloudflare Worker secrets, never GitHub files:

- `BOT_TOKEN`
- `BOT_OWNER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `SETUP_SECRET`

`TELEGRAM_WEBHOOK_SECRET` may contain only A-Z, a-z, 0-9, `_`, `-`.

## D1

Create a D1 database named:

`telegram-access-control`

Then replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `wrangler.jsonc`.

Apply `migrations/0001_init.sql` to the database using either:

```bash
npm install
npx wrangler login
npm run db:migrate:remote
```

or the D1 dashboard SQL console.

## Cloudflare deployment from GitHub

1. Push the whole project to a GitHub repository.
2. In Cloudflare go to Workers & Pages.
3. Create application -> Import a repository.
4. Connect GitHub and select the repository.
5. Worker name must match `telegram-access-control-bot`.
6. Deploy.
7. Add the four secrets in Worker Settings -> Variables and Secrets.
8. Ensure D1 is bound as variable `DB`.
9. Redeploy if Cloudflare asks you to.

## Register webhook

After deployment, suppose the Worker URL is:

`https://telegram-access-control-bot.YOUR-SUBDOMAIN.workers.dev`

Windows PowerShell:

```powershell
.\scripts\setup-webhook.ps1 `
  -WorkerUrl "https://telegram-access-control-bot.YOUR-SUBDOMAIN.workers.dev" `
  -SetupSecret "YOUR_SETUP_SECRET"
```

macOS/Linux:

```bash
chmod +x scripts/setup-webhook.sh
./scripts/setup-webhook.sh \
  "https://telegram-access-control-bot.YOUR-SUBDOMAIN.workers.dev" \
  "YOUR_SETUP_SECRET"
```

Or call:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_SETUP_SECRET" \
  "https://telegram-access-control-bot.YOUR-SUBDOMAIN.workers.dev/admin/setup-webhook"
```

## Health check

Open:

`https://YOUR-WORKER.workers.dev/health`

Expected:

```json
{
  "ok": true,
  "service": "telegram-access-control-bot",
  "version": "3.0.0",
  "database": "ok"
}
```

## First Telegram use

1. Open your bot privately and press Start.
2. Add the bot to your group.
3. Promote it to admin with Delete Messages + Ban/Restrict Members.
4. The bot displays the group ID.
5. Authorize it:

Inside group:

```text
/authorize
```

or private:

```text
/authorize -1001234567890
```

## Commands

Anyone can see only their own ID:

```text
/whoami
```

Owner:

```text
/controlleradd USER_ID
/controllerremove USER_ID
/controllers
```

Global controllers:

```text
/authorize GROUP_ID
/deauthorize GROUP_ID
/groups
```

Any controller who has permission for a group:

```text
/check GROUP_ID
/settings GROUP_ID
/allow GROUP_ID USER_ID
/block GROUP_ID USER_ID
/recent GROUP_ID
/autoblock GROUP_ID on|off
/strict GROUP_ID on|off
/deletejoins GROUP_ID on|off
/deletecommands GROUP_ID on|off
/groupadmins GROUP_ID
/groupadminadd GROUP_ID USER_ID
/groupadminremove GROUP_ID USER_ID
```

Inside an authorized group, omit `GROUP_ID`:

```text
/allow USER_ID
/block USER_ID
/recent
/check
/settings
```

You can also reply to a member's existing message with:

```text
/allow
```

or:

```text
/block
```

## Controller hierarchy

`BOT_OWNER_ID` is the permanent owner.

Owner can add global controllers:

```text
/controlleradd 123456789
```

A controller can be limited to one group:

```text
/groupadminadd 123456789
```

A group-specific controller cannot manage other groups unless separately assigned.

## Hide Members

Telegram's Hide Members option remains a Telegram setting, not a Bot API feature.

When Telegram exposes the setting for your supergroup, turn it on in Telegram. Keep selected senders as normal members and use `/allow` instead of making them group administrators.

## Security

Never commit `.dev.vars`, `.env`, the BotFather token, or production secrets.

If a BotFather token leaks, revoke it immediately in BotFather.
