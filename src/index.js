import { ensureGlobalAllowlistSchema } from "./db.js";
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
  {
    command: "whoami",
    description: "Show your numeric Telegram user ID",
  },
];

const OWNER_COMMANDS = [
  {
    command: "start",
    description: "Bot status and groups waiting for approval",
  },
  {
    command: "help",
    description: "Show the owner workflow",
  },
  {
    command: "whoami",
    description: "Show your numeric Telegram user ID",
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "telegram-global-allowlist-bot",
          version: VERSION,
          health: "/health",
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        validate(env);

        await ensureGlobalAllowlistSchema(env);
        const db = await env.DB.prepare(`SELECT 1 AS ok`).first();

        return json({
          ok: db?.ok === 1,
          service: "telegram-global-allowlist-bot",
          version: VERSION,
          database: db?.ok === 1 ? "ok" : "error",
        }, db?.ok === 1 ? 200 : 500);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/admin/setup-webhook"
      ) {
        requireSetupAuth(request, env);
        validate(env);

        await ensureGlobalAllowlistSchema(env);

        const webhookUrl = `${url.origin}/webhook`;

        const telegramResult = await tg(env, "setWebhook", {
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: false,
        });

        let commandsInstalled = false;
        let commandMenuWarning = null;

        try {
          await installCommands(env);
          commandsInstalled = true;
        } catch (error) {
          commandMenuWarning = safeError(error);
        }

        return json({
          ok: true,
          webhook_url: webhookUrl,
          telegram: telegramResult,
          commands_installed: commandsInstalled,
          command_menu_warning: commandMenuWarning,
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/admin/setup-commands"
      ) {
        requireSetupAuth(request, env);
        validate(env);

        await installCommands(env);

        return json({
          ok: true,
          owner_id: env.BOT_OWNER_ID,
          commands_installed: true,
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/admin/webhook-info"
      ) {
        requireSetupAuth(request, env);
        validate(env);

        return json({
          ok: true,
          telegram: await tg(env, "getWebhookInfo"),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/webhook"
      ) {
        validate(env);

        const secret = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );

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

        // No D1 duplicate-claim gate here.
        // A database hiccup must never make /start or /whoami disappear.
        try {
          await handleUpdate(update, env, ctx);
        } catch (error) {
          console.error(
            `Telegram update ${update.update_id} failed:`,
            safeError(error)
          );

          // Return 200 to avoid Telegram retry storms. Operations are designed
          // to report their own actionable errors to the owner where possible.
          return json({
            ok: true,
            handled: false,
            error_logged: true,
          });
        }

        return json({ ok: true });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker request failed:", safeError(error));

      return json({
        ok: false,
        error: safeError(error),
      }, error?.status || 500);
    }
  },
};

async function installCommands(env) {
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
}

function validate(env) {
  const missing = [];

  for (const key of [
    "BOT_TOKEN",
    "BOT_OWNER_ID",
    "TELEGRAM_WEBHOOK_SECRET",
    "SETUP_SECRET",
  ]) {
    if (!env[key]) {
      missing.push(key);
    }
  }

  if (!env.DB) {
    missing.push("DB binding");
  }

  if (missing.length) {
    const error = new Error(
      `Missing configuration: ${missing.join(", ")}`
    );

    error.status = 500;
    throw error;
  }
}

function requireSetupAuth(request, env) {
  const authorization = request.headers.get("Authorization") || "";

  if (
    !env.SETUP_SECRET ||
    authorization !== `Bearer ${env.SETUP_SECRET}`
  ) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}
