import { claimUpdate, releaseUpdate } from "./db.js";
import { handleUpdate } from "./bot.js";
import { tg } from "./telegram.js";
import { json, safeError, VERSION } from "./util.js";

const ALLOWED_UPDATES = [
  "message",
  "chat_member",
  "my_chat_member",
  "callback_query",
];

const DEFAULT_COMMANDS = [
  { command: "whoami", description: "Show your numeric Telegram user ID" },
];

const OWNER_COMMANDS = [
  { command: "start", description: "Show pending groups waiting for approval" },
  { command: "help", description: "Show the simple owner workflow" },
  { command: "whoami", description: "Show your numeric Telegram user ID" },
];

async function installBotCommands(env) {
  await tg(env, "setMyCommands", {
    commands: DEFAULT_COMMANDS,
    scope: { type: "default" },
  });

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
          service: "telegram-simple-allowlist-bot",
          version: VERSION,
          health: "/health",
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const r = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({
          ok: r?.ok === 1,
          service: "telegram-simple-allowlist-bot",
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
          commandMenuWarning = safeError(error);
          console.warn("Could not install command menu:", error);
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

        return json({
          ok: true,
          telegram: await tg(env, "getWebhookInfo"),
        });
      }

      if (url.pathname === "/webhook" && request.method === "POST") {
        validate(env);

        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }

        let update;
        try {
          update = await request.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

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
      return json(
        { ok: false, error: safeError(error) },
        error?.status || 500
      );
    }
  },
};

function validate(env) {
  const missing = [];

  for (const key of [
    "BOT_TOKEN",
    "BOT_OWNER_ID",
    "TELEGRAM_WEBHOOK_SECRET",
    "SETUP_SECRET",
  ]) {
    if (!env[key]) missing.push(key);
  }

  if (!env.DB) missing.push("DB binding");

  if (missing.length) {
    const error = new Error(`Missing configuration: ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
}

function requireSetupAuth(request, env) {
  const authorization = request.headers.get("Authorization") || "";

  if (!env.SETUP_SECRET || authorization !== `Bearer ${env.SETUP_SECRET}`) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}
