import {
  audit, canManageGroup, getAuthorizedGroup, getGroup, isAllowedMember,
  isGlobalController, isGroupController, isOwner, rememberGroup, rememberUser
} from "./db.js";
import {
  allowedSendPermissions, deleteMessageSafe, getChatMember, isTelegramAdmin,
  readonlyPermissions, sendMessage, tg
} from "./telegram.js";
import { escapeHtml, nowIso, safeError, toId, userLabel } from "./util.js";

export async function handleUpdate(update, env) {
  if (update.my_chat_member) return handleMyChatMember(update.my_chat_member, env);
  if (update.chat_member) return handleChatMember(update.chat_member, env);
  if (update.message) return handleMessage(update.message, env);
}

function present(status, member) {
  if (["member", "administrator", "creator"].includes(status)) return true;
  if (status === "restricted") return Boolean(member?.is_member);
  return false;
}

async function makeReadOnly(env, groupId, userId, actorUserId = null, reason = "automatic") {
  if (await isTelegramAdmin(env, groupId, userId)) return { ok: false, reason: "telegram_admin" };

  await tg(env, "restrictChatMember", {
    chat_id: groupId,
    user_id: userId,
    permissions: readonlyPermissions(),
    use_independent_chat_permissions: true,
  });

  await env.DB.prepare(
    `DELETE FROM allowed_members WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).run();

  await audit(env, "member_blocked", {
    actorUserId, groupId, targetUserId: userId, details: { reason }
  });
  return { ok: true };
}

async function allowMember(env, groupId, userId, actorUserId = null) {
  const member = await getChatMember(env, groupId, userId);
  if (["creator", "administrator"].includes(member.status)) {
    return { ok: false, reason: "telegram_admin", member };
  }

  await tg(env, "restrictChatMember", {
    chat_id: groupId,
    user_id: userId,
    permissions: allowedSendPermissions(),
    use_independent_chat_permissions: true,
  });

  const u = member.user || { id: userId };
  await env.DB.prepare(
    `INSERT INTO allowed_members
      (group_id, user_id, username, first_name, last_name, allowed_by, allowed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       allowed_by = excluded.allowed_by,
       allowed_at = excluded.allowed_at`
  ).bind(
    groupId, userId, u.username || "", u.first_name || "", u.last_name || "",
    actorUserId, nowIso()
  ).run();

  await rememberUser(env, groupId, u);
  await audit(env, "member_allowed", { actorUserId, groupId, targetUserId: userId });
  return { ok: true, member };
}

async function processJoin(env, chat, user, reason) {
  if (!user?.id || user.is_bot) return;
  await rememberUser(env, chat.id, user);

  const g = await getAuthorizedGroup(env, chat.id);
  if (!g?.auto_restrict_new_members) return;
  if (await isGroupController(env, chat.id, user.id)) return;
  if (await isAllowedMember(env, chat.id, user.id)) return;
  if (await isTelegramAdmin(env, chat.id, user.id)) return;

  try {
    await makeReadOnly(env, chat.id, user.id, null, reason);
  } catch (e) {
    console.error("Auto restriction failed:", safeError(e));
  }
}

async function handleMyChatMember(update, env) {
  const chat = update.chat;
  if (!chat || !["group", "supergroup"].includes(chat.type)) return;
  await rememberGroup(env, chat);

  const oldIn = present(update.old_chat_member?.status, update.old_chat_member);
  const newIn = present(update.new_chat_member?.status, update.new_chat_member);
  if (oldIn || !newIn) return;

  const g = await getGroup(env, chat.id);
  const status = g?.authorized ? "AUTHORIZED ✅" : "NOT AUTHORIZED ❌";
  const text =
    `<b>Access Control Bot connected</b>\n\n` +
    `Group: ${escapeHtml(chat.title || String(chat.id))}\n` +
    `Group ID: <code>${chat.id}</code>\n` +
    `Status: ${status}\n\n` +
    (g?.authorized
      ? "Management is active."
      : `A global bot controller must authorize this group.\n` +
        `Inside group: <code>/authorize</code>\n` +
        `Private: <code>/authorize ${chat.id}</code>`);

  try { await sendMessage(env, chat.id, text); } catch {}
  await notifyGlobalControllers(env,
    `<b>Bot added to a group</b>\n\n${escapeHtml(chat.title || String(chat.id))}\n` +
    `Group ID: <code>${chat.id}</code>\nStatus: ${status}`
  );

  await audit(env, "bot_added_to_group", {
    actorUserId: update.from?.id || null, groupId: chat.id
  });
}

async function handleChatMember(update, env) {
  const chat = update.chat;
  const user = update.new_chat_member?.user;
  if (!chat?.id || !user?.id) return;

  await rememberGroup(env, chat);
  await rememberUser(env, chat.id, user);

  const oldIn = present(update.old_chat_member?.status, update.old_chat_member);
  const newIn = present(update.new_chat_member?.status, update.new_chat_member);
  if (!oldIn && newIn) await processJoin(env, chat, user, "chat_member_join");
}

async function handleMessage(message, env) {
  const chat = message.chat;
  const from = message.from;

  if (["group", "supergroup"].includes(chat?.type)) {
    await rememberGroup(env, chat);
    if (from?.id) await rememberUser(env, chat.id, from);

    if (Array.isArray(message.new_chat_members) && message.new_chat_members.length) {
      for (const u of message.new_chat_members) {
        await processJoin(env, chat, u, "new_chat_members");
      }
      const g = await getAuthorizedGroup(env, chat.id);
      if (g?.delete_join_messages) {
        await deleteMessageSafe(env, chat.id, message.message_id);
      }
      return;
    }
  }

  if (message.text?.startsWith("/")) {
    const handled = await handleCommand(message, env);
    if (handled) return;
  }

  if (!["group", "supergroup"].includes(chat?.type) || !from?.id || from.is_bot) return;

  const g = await getAuthorizedGroup(env, chat.id);
  if (!g?.strict_enforcement) return;
  if (await isGroupController(env, chat.id, from.id)) return;
  if (await isAllowedMember(env, chat.id, from.id)) return;
  if (await isTelegramAdmin(env, chat.id, from.id)) return;

  await deleteMessageSafe(env, chat.id, message.message_id);
  try {
    await makeReadOnly(env, chat.id, from.id, null, "strict_enforcement");
  } catch (e) {
    console.error("Strict restriction failed:", safeError(e));
  }
}

function parseCommand(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (!parts[0]?.startsWith("/")) return null;
  return {
    command: parts.shift().slice(1).split("@")[0].toLowerCase(),
    args: parts,
  };
}

function groupContext(message, args) {
  if (message.chat.type !== "private") return { groupId: message.chat.id, args };
  const maybe = toId(args[0]);
  if (maybe !== null && maybe < 0) return { groupId: maybe, args: args.slice(1) };
  return { groupId: null, args };
}

async function handleCommand(message, env) {
  const p = parseCommand(message.text);
  if (!p || !message.from?.id) return false;
  const actor = message.from.id;

  if (["whoami", "id"].includes(p.command)) {
    await sendMessage(env, message.chat.id,
      `<b>Your Telegram user ID</b>\n<code>${actor}</code>`);
    return true;
  }

  const global = await isGlobalController(env, actor);

  if (p.command === "start") {
    if (!global) {
      await sendMessage(env, message.chat.id,
        `This bot is privately controlled.\n\nYour Telegram ID: <code>${actor}</code>`);
      return true;
    }
    await sendMessage(env, message.chat.id, await helpText(env, actor));
    return true;
  }

  if (p.command === "help") {
    if (message.chat.type === "private" && !global) return deny(env, message, p.command);
    if (message.chat.type !== "private" && !(await isGroupController(env, message.chat.id, actor))) {
      return deny(env, message, p.command);
    }
    await maybeDeleteCommand(env, message);
    await respond(env, message, await helpText(env, actor));
    return true;
  }

  if (["controlleradd", "controllerremove"].includes(p.command)) {
    if (!isOwner(env, actor)) return deny(env, message, p.command);
    await maybeDeleteCommand(env, message);
    await mutateGlobalController(env, message, p.args, p.command === "controlleradd");
    return true;
  }

  if (p.command === "controllers") {
    if (!global) return deny(env, message, p.command);
    await maybeDeleteCommand(env, message);
    await listControllers(env, message);
    return true;
  }

  if (["authorize", "deauthorize"].includes(p.command)) {
    if (!global) return deny(env, message, p.command);
    await maybeDeleteCommand(env, message);
    await authorizeGroup(env, message, p.args, p.command === "authorize");
    return true;
  }

  if (p.command === "groups") {
    if (!global) {
      if (message.chat.type === "private") {
        const x = await env.DB.prepare(
          `SELECT 1 FROM group_controllers WHERE user_id = ? LIMIT 1`
        ).bind(actor).first();
        if (!x) return deny(env, message, p.command);
      } else if (!(await isGroupController(env, message.chat.id, actor))) {
        return deny(env, message, p.command);
      }
    }
    await maybeDeleteCommand(env, message);
    await listGroups(env, message);
    return true;
  }

  const ctx = groupContext(message, p.args);
  if (!ctx.groupId) {
    if (message.chat.type === "private") {
      await sendMessage(env, message.chat.id,
        `This command needs a group ID.\nExample: <code>/${p.command} -1001234567890</code>`);
    }
    return true;
  }

  if (!(await canManageGroup(env, ctx.groupId, actor))) return deny(env, message, p.command);
  await maybeDeleteCommand(env, message);

  switch (p.command) {
    case "check": await checkGroup(env, message, ctx.groupId); return true;
    case "settings":
    case "status": await settings(env, message, ctx.groupId); return true;
    case "allow": await allowBlock(env, message, ctx.groupId, ctx.args, true); return true;
    case "block":
    case "readonly": await allowBlock(env, message, ctx.groupId, ctx.args, false); return true;
    case "recent":
    case "members": await recent(env, message, ctx.groupId); return true;
    case "autoblock": await toggle(env, message, ctx.groupId, ctx.args, "auto_restrict_new_members", "Auto-restrict newcomers"); return true;
    case "strict": await toggle(env, message, ctx.groupId, ctx.args, "strict_enforcement", "Strict enforcement"); return true;
    case "deletejoins": await toggle(env, message, ctx.groupId, ctx.args, "delete_join_messages", "Delete join messages"); return true;
    case "deletecommands": await toggle(env, message, ctx.groupId, ctx.args, "delete_controller_commands", "Delete controller commands"); return true;
    case "groupadminadd": await mutateGroupController(env, message, ctx.groupId, ctx.args, true); return true;
    case "groupadminremove": await mutateGroupController(env, message, ctx.groupId, ctx.args, false); return true;
    case "groupadmins": await listGroupControllers(env, message, ctx.groupId); return true;
    default: return false;
  }
}

async function deny(env, message, command) {
  if (message.chat.type === "private") {
    await sendMessage(env, message.chat.id,
      `⛔ <b>Access denied</b>\n\nYour Telegram ID: <code>${message.from.id}</code>`);
  } else {
    await deleteMessageSafe(env, message.chat.id, message.message_id);
  }
  await audit(env, "unauthorized_command", {
    actorUserId: message.from.id,
    groupId: message.chat.type === "private" ? null : message.chat.id,
    details: { command },
  });
  return true;
}

async function maybeDeleteCommand(env, message) {
  if (message.chat.type === "private") return;
  const g = await getGroup(env, message.chat.id);
  if (g?.delete_controller_commands) {
    await deleteMessageSafe(env, message.chat.id, message.message_id);
  }
}

async function respond(env, message, text) {
  if (message.chat.type === "private") return sendMessage(env, message.chat.id, text);
  try {
    return await sendMessage(env, message.from.id, text);
  } catch {
    return sendMessage(env, message.chat.id,
      `${text}\n\n<i>Open the bot privately and press Start so future admin results can be sent privately.</i>`);
  }
}

async function notifyGlobalControllers(env, text) {
  const ids = new Set([String(env.BOT_OWNER_ID)]);
  const r = await env.DB.prepare(`SELECT user_id FROM controllers`).all();
  for (const row of r.results || []) ids.add(String(row.user_id));
  for (const id of ids) {
    try { await sendMessage(env, id, text); } catch {}
  }
}

async function helpText(env, actor) {
  let text =
    `<b>Access Control Bot</b>\n\n` +
    `<b>Private chat</b>\n` +
    `<code>/groups</code>\n` +
    `<code>/check GROUP_ID</code>\n` +
    `<code>/settings GROUP_ID</code>\n` +
    `<code>/allow GROUP_ID USER_ID</code>\n` +
    `<code>/block GROUP_ID USER_ID</code>\n` +
    `<code>/recent GROUP_ID</code>\n` +
    `<code>/autoblock GROUP_ID on|off</code>\n` +
    `<code>/strict GROUP_ID on|off</code>\n` +
    `<code>/deletejoins GROUP_ID on|off</code>\n` +
    `<code>/deletecommands GROUP_ID on|off</code>\n` +
    `<code>/groupadmins GROUP_ID</code>\n` +
    `<code>/groupadminadd GROUP_ID USER_ID</code>\n` +
    `<code>/groupadminremove GROUP_ID USER_ID</code>\n\n` +
    `<b>Inside an authorized group</b>\n` +
    `Omit GROUP_ID. You can also reply to a member with <code>/allow</code> or <code>/block</code>.\n\n` +
    `<b>Global controllers</b>\n` +
    `<code>/authorize GROUP_ID</code>\n` +
    `<code>/deauthorize GROUP_ID</code>\n` +
    `<code>/controllers</code>`;
  if (isOwner(env, actor)) {
    text += `\n\n<b>Owner only</b>\n<code>/controlleradd USER_ID</code>\n<code>/controllerremove USER_ID</code>`;
  }
  return text;
}

async function mutateGlobalController(env, message, args, add) {
  const id = toId(args[0]);
  if (!id || id <= 0) return respond(env, message,
    `Usage: <code>/${add ? "controlleradd" : "controllerremove"} USER_ID</code>`);
  if (String(id) === String(env.BOT_OWNER_ID)) {
    return respond(env, message, "BOT_OWNER_ID cannot be removed by Telegram command.");
  }
  if (add) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO controllers (user_id, added_by, created_at) VALUES (?, ?, ?)`
    ).bind(id, message.from.id, nowIso()).run();
  } else {
    await env.DB.prepare(`DELETE FROM controllers WHERE user_id = ?`).bind(id).run();
  }
  await audit(env, add ? "controller_added" : "controller_removed", {
    actorUserId: message.from.id, targetUserId: id
  });
  return respond(env, message,
    `✅ Global controller ${add ? "added" : "removed"}: <code>${id}</code>`);
}

async function listControllers(env, message) {
  const r = await env.DB.prepare(`SELECT user_id FROM controllers ORDER BY created_at`).all();
  const lines = [`<code>${env.BOT_OWNER_ID}</code> — owner`];
  for (const row of r.results || []) lines.push(`<code>${row.user_id}</code> — global controller`);
  return respond(env, message, `<b>Bot controllers</b>\n\n${lines.join("\n")}`);
}

async function authorizeGroup(env, message, args, enable) {
  const groupId = message.chat.type === "private" ? toId(args[0]) : message.chat.id;
  if (!groupId || groupId >= 0) {
    return respond(env, message,
      `Usage: <code>/${enable ? "authorize" : "deauthorize"} -1001234567890</code>`);
  }

  if (!enable) {
    const g = await getGroup(env, groupId);
    if (!g) return respond(env, message, "I do not know that group.");
    await env.DB.prepare(
      `UPDATE groups SET authorized = 0, updated_at = ? WHERE chat_id = ?`
    ).bind(nowIso(), groupId).run();
    await audit(env, "group_deauthorized", { actorUserId: message.from.id, groupId });
    return respond(env, message, `✅ Management disabled for <code>${groupId}</code>.`);
  }

  try {
    const chat = await tg(env, "getChat", { chat_id: groupId });
    const me = await tg(env, "getMe");
    const bm = await getChatMember(env, groupId, me.id);

    if (chat.type !== "supergroup") {
      return respond(env, message, "This bot requires a Telegram <b>supergroup</b>.");
    }

    const admin = ["creator", "administrator"].includes(bm.status);
    const del = bm.status === "creator" || Boolean(bm.can_delete_messages);
    const restrict = bm.status === "creator" || Boolean(bm.can_restrict_members);

    if (!admin || !del || !restrict) {
      const missing = [];
      if (!admin) missing.push("Bot is not an administrator");
      if (!del) missing.push("Delete Messages");
      if (!restrict) missing.push("Ban/Restrict Members");
      return respond(env, message,
        `<b>Cannot authorize yet</b>\n\n${missing.map(x => `• ${escapeHtml(x)}`).join("\n")}`);
    }

    await rememberGroup(env, chat);
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE groups SET authorized = 1, authorized_by = ?, authorized_at = ?, updated_at = ?
       WHERE chat_id = ?`
    ).bind(message.from.id, now, now, groupId).run();

    await audit(env, "group_authorized", { actorUserId: message.from.id, groupId });
    await respond(env, message,
      `✅ <b>Group authorized</b>\n\n${escapeHtml(chat.title || String(groupId))}\n` +
      `<code>${groupId}</code>\n\nAuto-restrict: ON\nStrict enforcement: ON\nDelete join notices: ON`);
    try {
      await sendMessage(env, groupId,
        "✅ <b>Access Control Bot activated</b>\nOnly approved normal members can send messages.");
    } catch {}
  } catch (e) {
    return respond(env, message, `<b>Authorization failed</b>\n${escapeHtml(safeError(e))}`);
  }
}

async function listGroups(env, message) {
  const actor = message.from.id;
  const global = await isGlobalController(env, actor);
  const r = global
    ? await env.DB.prepare(
        `SELECT chat_id, title FROM groups WHERE authorized = 1 ORDER BY title`
      ).all()
    : await env.DB.prepare(
        `SELECT g.chat_id, g.title FROM groups g
         JOIN group_controllers gc ON gc.group_id = g.chat_id
         WHERE g.authorized = 1 AND gc.user_id = ? ORDER BY g.title`
      ).bind(actor).all();

  if (!(r.results || []).length) return respond(env, message, "No authorized groups.");
  return respond(env, message, `<b>Authorized groups</b>\n\n` +
    r.results.map(x => `${escapeHtml(x.title || String(x.chat_id))}\n<code>${x.chat_id}</code>`).join("\n\n"));
}

async function checkGroup(env, message, groupId) {
  try {
    const chat = await tg(env, "getChat", { chat_id: groupId });
    const me = await tg(env, "getMe");
    const bm = await getChatMember(env, groupId, me.id);
    const g = await getGroup(env, groupId);

    const admin = ["creator", "administrator"].includes(bm.status);
    const del = bm.status === "creator" || Boolean(bm.can_delete_messages);
    const restrict = bm.status === "creator" || Boolean(bm.can_restrict_members);
    const globalSend = chat.permissions?.can_send_messages !== false;

    const warning = globalSend ? "" :
      `\n\n⚠️ <b>Global Send Messages is OFF.</b>\nTurn it ON. The bot must control posting with individual member restrictions.`;

    return respond(env, message,
      `<b>Setup check</b>\n\n${escapeHtml(chat.title || String(groupId))}\n<code>${groupId}</code>\n\n` +
      `Supergroup: ${chat.type === "supergroup" ? "✅" : "❌"}\n` +
      `Bot administrator: ${admin ? "✅" : "❌"}\n` +
      `Delete Messages: ${del ? "✅" : "❌"}\n` +
      `Restrict Members: ${restrict ? "✅" : "❌"}\n` +
      `Group authorized: ${g?.authorized ? "✅" : "❌"}\n` +
      `Global Send Messages: ${globalSend ? "ON ✅" : "OFF ❌"}` + warning);
  } catch (e) {
    return respond(env, message, `<b>Check failed</b>\n${escapeHtml(safeError(e))}`);
  }
}

function onoff(v) { return Number(v) === 1 ? "ON ✅" : "OFF ❌"; }

async function settings(env, message, groupId) {
  const g = await getGroup(env, groupId);
  if (!g) return respond(env, message, "Group not found.");
  const ac = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM allowed_members WHERE group_id = ?`
  ).bind(groupId).first();
  const gc = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM group_controllers WHERE group_id = ?`
  ).bind(groupId).first();
  return respond(env, message,
    `<b>${escapeHtml(g.title || String(groupId))}</b>\nGroup ID: <code>${groupId}</code>\n\n` +
    `Authorized: ${onoff(g.authorized)}\n` +
    `Auto-restrict newcomers: ${onoff(g.auto_restrict_new_members)}\n` +
    `Strict enforcement: ${onoff(g.strict_enforcement)}\n` +
    `Delete join messages: ${onoff(g.delete_join_messages)}\n` +
    `Delete controller commands: ${onoff(g.delete_controller_commands)}\n` +
    `Allowed members: ${ac?.n || 0}\nGroup-specific controllers: ${gc?.n || 0}`);
}

async function resolveTarget(env, message, groupId, args) {
  const replied = message.reply_to_message?.from;
  if (message.chat.type !== "private" && replied?.id) return replied;

  const token = args[0];
  if (!token) return null;
  const id = toId(token);
  if (id && id > 0) {
    return await env.DB.prepare(
      `SELECT user_id AS id, username, first_name, last_name, is_bot
       FROM known_members WHERE group_id = ? AND user_id = ?`
    ).bind(groupId, id).first() || { id };
  }

  if (token.startsWith("@")) {
    return env.DB.prepare(
      `SELECT user_id AS id, username, first_name, last_name, is_bot
       FROM known_members WHERE group_id = ? AND lower(username) = ?
       ORDER BY last_seen_at DESC LIMIT 1`
    ).bind(groupId, token.slice(1).toLowerCase()).first();
  }
  return null;
}

async function allowBlock(env, message, groupId, args, allow) {
  const target = await resolveTarget(env, message, groupId, args);
  if (!target?.id) {
    return respond(env, message,
      "Could not resolve that member. Use a numeric USER_ID, a cached @username, or reply to the user's message. Use <code>/recent</code> to see known IDs.");
  }

  try {
    const r = allow
      ? await allowMember(env, groupId, target.id, message.from.id)
      : await makeReadOnly(env, groupId, target.id, message.from.id, "controller_command");

    if (!r.ok && r.reason === "telegram_admin") {
      return respond(env, message,
        "That account is a Telegram group administrator, so the bot cannot restrict it.");
    }

    let u = target;
    try {
      const m = await getChatMember(env, groupId, target.id);
      u = m.user || target;
      await rememberUser(env, groupId, u);
    } catch {}

    return respond(env, message,
      `${allow ? "✅ <b>Allowed to send</b>" : "🔒 <b>Read-only</b>"}\n` +
      `${escapeHtml(userLabel(u))}\n<code>${target.id}</code>`);
  } catch (e) {
    return respond(env, message, `<b>Action failed</b>\n${escapeHtml(safeError(e))}`);
  }
}

async function recent(env, message, groupId) {
  const r = await env.DB.prepare(
    `SELECT km.user_id, km.username, km.first_name, km.last_name, km.last_seen_at,
            CASE WHEN am.user_id IS NULL THEN 0 ELSE 1 END AS allowed
     FROM known_members km
     LEFT JOIN allowed_members am ON am.group_id = km.group_id AND am.user_id = km.user_id
     WHERE km.group_id = ?
     ORDER BY km.last_seen_at DESC LIMIT 30`
  ).bind(groupId).all();

  if (!(r.results || []).length) return respond(env, message, "No known members yet.");
  const lines = r.results.map((x, i) =>
    `${i+1}. ${escapeHtml(userLabel({id:x.user_id, username:x.username, first_name:x.first_name, last_name:x.last_name}))}\n` +
    `<code>${x.user_id}</code> — ${x.allowed ? "✅ allowed" : "🔒 default/read-only"}`
  );
  return respond(env, message, `<b>Recent known members</b>\n\n${lines.join("\n\n")}`);
}

async function toggle(env, message, groupId, args, column, label) {
  const allowed = new Set([
    "auto_restrict_new_members", "strict_enforcement",
    "delete_join_messages", "delete_controller_commands"
  ]);
  if (!allowed.has(column)) throw new Error("Invalid setting");
  const v = String(args[0] || "").toLowerCase();
  if (!["on", "off"].includes(v)) return respond(env, message, `Use <code>on</code> or <code>off</code>.`);

  await env.DB.prepare(
    `UPDATE groups SET ${column} = ?, updated_at = ? WHERE chat_id = ?`
  ).bind(v === "on" ? 1 : 0, nowIso(), groupId).run();

  await audit(env, "group_setting_changed", {
    actorUserId: message.from.id, groupId, details: { setting: column, value: v }
  });
  return respond(env, message, `${escapeHtml(label)}: ${v === "on" ? "ON ✅" : "OFF ❌"}`);
}

async function mutateGroupController(env, message, groupId, args, add) {
  const id = toId(args[0]);
  if (!id || id <= 0) return respond(env, message,
    `Usage: <code>/${add ? "groupadminadd" : "groupadminremove"} USER_ID</code>`);

  if (add) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO group_controllers (group_id, user_id, added_by, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(groupId, id, message.from.id, nowIso()).run();
    try { await allowMember(env, groupId, id, message.from.id); } catch {}
  } else {
    await env.DB.prepare(
      `DELETE FROM group_controllers WHERE group_id = ? AND user_id = ?`
    ).bind(groupId, id).run();
  }

  await audit(env, add ? "group_controller_added" : "group_controller_removed", {
    actorUserId: message.from.id, groupId, targetUserId: id
  });
  return respond(env, message,
    `✅ Group controller ${add ? "added" : "removed"}: <code>${id}</code>`);
}

async function listGroupControllers(env, message, groupId) {
  const r = await env.DB.prepare(
    `SELECT user_id FROM group_controllers WHERE group_id = ? ORDER BY created_at`
  ).bind(groupId).all();
  if (!(r.results || []).length) return respond(env, message, "No group-specific controllers.");
  return respond(env, message,
    `<b>Group-specific controllers</b>\n\n${r.results.map(x => `<code>${x.user_id}</code>`).join("\n")}`);
}
