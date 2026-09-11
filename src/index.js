import { claimUpdate, releaseUpdate } from "./db.js";
import { handleUpdate } from "./bot.js";
import { tg } from "./telegram.js";
import { json, safeError, VERSION } from "./util.js";

const ALLOWED_UPDATES = ["message", "chat_member", "my_chat_member"];

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
        return json({ ok: true, webhook_url: webhookUrl, telegram: result });
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
