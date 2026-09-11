import { claimUpdate, releaseUpdate } from "./db.js";
import { handleUpdate } from "./bot.js";
import { tg } from "./telegram.js";
import { json, safeError, VERSION } from "./util.js";

const ALLOWED_UPDATES = ["message", "chat_member", "my_chat_member"];

const DEFAULT_COMMANDS = [
  { command: "whoami", description: "Show your numeric Telegram user ID" },
];

const OWNER_COMMANDS = [
  { command: "help", description: "Show all bot commands and what each command does" },
  { command: "whoami", description: "Show your numeric Telegram user ID" },
  { command: "groups", description: "List authorized groups you can manage" },
  { command: "controllers", description: "List owner and global controller IDs" },
  { command: "authorize", description: "Authorize a group for bot management" },
  { command: "deauthorize", description: "Stop bot management for a group" },
  { command: "check", description: "Check bot permissions and group setup" },
  { command: "settings", description: "Show bot settings for a group" },
  { command: "recent", description: "Show recently detected members and IDs" },
  { command: "allow", description: "Allow a normal member to send messages" },
  { command: "block", description: "Make a normal member read-only" },
  { command: "autoblock", description: "Toggle automatic read-only for newcomers" },
  { command: "strict", description: "Toggle enforcement for unapproved senders" },
  { command: "deletejoins", description: "Toggle deletion of member join notices" },
  { command: "deletecommands", description: "Toggle deletion of admin bot commands" },
  { command: "groupadmins", description: "List group-specific bot controllers" },
  { command: "groupadminadd", description: "Add a controller for one group only" },
  { command: "groupadminremove", description: "Remove a group-specific controller" },
  { command: "controlleradd", description: "Owner: add a global bot controller" },
  { command: "controllerremove", description: "Owner: remove a global bot controller" },
];

async function installBotCommands(env) {
  // Keep the public/default menu intentionally minimal.
  await tg(env, "setMyCommands", {
    commands: DEFAULT_COMMANDS,
    scope: { type: "default" },
  });

  // Full clickable command menu appears in the owner's private chat only.
  await tg(env, "setMyCommands", {
    commands: OWNER_COMMANDS,
    scope: {
      type: "chat",
      chat_id: Number(env.BOT_OWNER_ID),
    },
  });

  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "telegram-access-control-bot",
          version: VERSION,
          health: "/health",
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const r = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({
          ok: r?.ok === 1,
          service: "telegram-access-control-bot",
          version: VERSION,
          database: r?.ok === 1 ? "ok" : "error",
        }, r?.ok === 1 ? 200 : 500);
      }

      if (url.pathname === "/admin/setup-webhook" && request.method === "POST") {
        requireSetupAuth(request, env);
        validate(env);
        const webhookUrl = `${url.origin}/webhook`;
        const result = await tg(env, "setWebhook", {
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: true,
        });

        let commandsInstalled = false;
        let commandMenuWarning = null;
        try {
          commandsInstalled = await installBotCommands(env);
        } catch (error) {
          // Webhook setup should still succeed even if Telegram refuses a command scope
          // before the owner has opened/started the bot.
          commandMenuWarning = safeError(error);
          console.warn("Could not install owner command menu:", error);
        }

        return json({
          ok: true,
          webhook_url: webhookUrl,
          telegram: result,
          commands_installed: commandsInstalled,
          command_menu_warning: commandMenuWarning,
        });
      }

      if (url.pathname === "/admin/setup-commands" && request.method === "POST") {
        requireSetupAuth(request, env);
        validate(env);
        await installBotCommands(env);
        return json({
          ok: true,
          owner_id: env.BOT_OWNER_ID,
          commands_installed: true,
        });
      }

      if (url.pathname === "/admin/webhook-info" && request.method === "GET") {
        requireSetupAuth(request, env);
        validate(env);
        return json({ ok: true, telegram: await tg(env, "getWebhookInfo") });
      }

      if (url.pathname === "/admin/delete-webhook" && request.method === "POST") {
        requireSetupAuth(request, env);
        validate(env);
        return json({
          ok: true,
          telegram: await tg(env, "deleteWebhook", { drop_pending_updates: true }),
        });
      }

      if (url.pathname === "/webhook" && request.method === "POST") {
        validate(env);
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }

        let update;
        try { update = await request.json(); }
        catch { return new Response("Bad Request", { status: 400 }); }

        if (!Number.isInteger(update?.update_id)) {
          return new Response("Bad Request", { status: 400 });
        }

        if (!(await claimUpdate(env, update.update_id))) {
          return json({ ok: true, duplicate: true });
        }

        try {
          await handleUpdate(update, env);
          return json({ ok: true });
        } catch (error) {
          await releaseUpdate(env, update.update_id);
          console.error("Webhook update failed:", error);
          return json({ ok: false, error: safeError(error) }, 500);
        }
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Request failed:", error);
      return json({ ok: false, error: safeError(error) }, error?.status || 500);
    }
  },
};

function validate(env) {
  const missing = [];
  for (const k of ["BOT_TOKEN", "BOT_OWNER_ID", "TELEGRAM_WEBHOOK_SECRET", "SETUP_SECRET"]) {
    if (!env[k]) missing.push(k);
  }
  if (!env.DB) missing.push("DB binding");
  if (missing.length) {
    const e = new Error(`Missing configuration: ${missing.join(", ")}`);
    e.status = 500;
    throw e;
  }
}

function requireSetupAuth(request, env) {
  const got = request.headers.get("Authorization") || "";
  if (!env.SETUP_SECRET || got !== `Bearer ${env.SETUP_SECRET}`) {
    const e = new Error("Unauthorized");
    e.status = 401;
    throw e;
  }
}
