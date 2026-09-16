import {
  audit,
  getAuthorizedGroup,
  getAuthorizedGroups,
  getGroup,
  isGlobalAllowedMember,
  isOwner,
  rememberGroup,
  rememberUser,
  replaceGlobalAllowlist,
} from "./db.js";

import {
  allowedSendPermissions,
  deleteMessageSafe,
  getChatMember,
  isTelegramAdmin,
  readonlyPermissions,
  sendMessage,
  tg,
} from "./telegram.js";

import {
  escapeHtml,
  nowIso,
  safeError,
  userLabel,
} from "./util.js";

const MAX_ID_LIST = 200;

export async function handleUpdate(update, env) {
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query, env);
  }

  if (update.my_chat_member) {
    return handleMyChatMember(update.my_chat_member, env);
  }

  if (update.chat_member) {
    return handleChatMember(update.chat_member, env);
  }

  if (update.message) {
    return handleMessage(update.message, env);
  }
}

function present(status, member) {
  if (["member", "administrator", "creator"].includes(status)) return true;
  if (status === "restricted") return Boolean(member?.is_member);
  return false;
}

function ownerId(env) {
  return Number(env.BOT_OWNER_ID);
}

function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

async function makeReadOnly(
  env,
  groupId,
  userId,
  actorUserId = null,
  reason = "automatic"
) {
  if (String(userId) === String(env.BOT_OWNER_ID)) {
    return { ok: false, reason: "owner" };
  }

  if (await isTelegramAdmin(env, groupId, userId)) {
    return { ok: false, reason: "telegram_admin" };
  }

  await tg(env, "restrictChatMember", {
    chat_id: groupId,
    user_id: userId,
    permissions: readonlyPermissions(),
    use_independent_chat_permissions: true,
  });

  await env.DB.prepare(
    `DELETE FROM allowed_members
     WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).run();

  await audit(env, "member_blocked", {
    actorUserId,
    groupId,
    targetUserId: userId,
    details: { reason },
  });

  return { ok: true };
}

async function upsertAllowId(env, groupId, userId, actorUserId) {
  let user = {
    id: userId,
    username: "",
    first_name: "",
    last_name: "",
  };

  try {
    const member = await getChatMember(env, groupId, userId);

    if (member?.user) {
      user = member.user;
      await rememberUser(env, groupId, user);
    }

    if (!["creator", "administrator"].includes(member.status)) {
      await tg(env, "restrictChatMember", {
        chat_id: groupId,
        user_id: userId,
        permissions: allowedSendPermissions(),
        use_independent_chat_permissions: true,
      });
    }
  } catch (error) {
    // The ID may belong to a user who is not in the group yet.
    // Keep it in the allowlist so it is automatically allowed if they join later.
    console.log(
      `Allowlist stored for future/current member ${userId}:`,
      safeError(error)
    );
  }

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
    groupId,
    userId,
    user.username || "",
    user.first_name || "",
    user.last_name || "",
    actorUserId,
    nowIso()
  ).run();

  await audit(env, "member_allowed", {
    actorUserId,
    groupId,
    targetUserId: userId,
  });

  return user;
}

async function setDefaultGroupSendingOn(env, groupId) {
  await tg(env, "setChatPermissions", {
    chat_id: groupId,
    permissions: allowedSendPermissions(),
    use_independent_chat_permissions: true,
  });
}

async function processJoin(env, chat, user, reason) {
  if (!user?.id || user.is_bot) return;

  await rememberUser(env, chat.id, user);

  const group = await getAuthorizedGroup(env, chat.id);
  if (!group) return;

  if (String(user.id) === String(env.BOT_OWNER_ID)) return;
  if (await isTelegramAdmin(env, chat.id, user.id)) return;

  if (await isGlobalAllowedMember(env, user.id)) {
    try {
      await upsertAllowId(env, chat.id, user.id, ownerId(env));
    } catch (error) {
      console.error("Could not activate globally allowlisted joiner:", safeError(error));
    }
    return;
  }

  try {
    await makeReadOnly(env, chat.id, user.id, null, reason);
  } catch (error) {
    console.error("Could not restrict new member:", safeError(error));
  }
}

async function handleMyChatMember(update, env) {
  const chat = update.chat;

  if (!isGroupChat(chat)) return;

  await rememberGroup(env, chat);

  const oldPresent = present(
    update.old_chat_member?.status,
    update.old_chat_member
  );

  const newPresent = present(
    update.new_chat_member?.status,
    update.new_chat_member
  );

  if (!oldPresent && newPresent) {
    await notifyOwnerForApproval(env, chat);
  }
}

async function notifyOwnerForApproval(env, chat) {
  const text =
    `<b>Bot added to a group</b>\n\n` +
    `Group: ${escapeHtml(chat.title || String(chat.id))}\n` +
    `Group ID: <code>${chat.id}</code>\n\n` +
    `Approve this group for allowlist control?`;

  const replyMarkup = {
    inline_keyboard: [[
      {
        text: "✅ Approve",
        callback_data: `approve:${chat.id}`,
      },
      {
        text: "❌ Reject",
        callback_data: `reject:${chat.id}`,
      },
    ]],
  };

  try {
    await sendMessage(
      env,
      ownerId(env),
      text,
      { reply_markup: replyMarkup }
    );
  } catch (error) {
    console.warn("Could not DM owner:", safeError(error));

    try {
      await sendMessage(
        env,
        chat.id,
        `⚠️ I could not privately contact the bot owner.\n\n` +
        `Owner: open this bot privately and press <b>Start</b>. ` +
        `Then send <code>/start</code> to see groups waiting for approval.`
      );
    } catch {}
  }

  await audit(env, "group_pending_approval", {
    groupId: chat.id,
  });
}

async function showPendingGroups(env, chatId) {
  const rows = await env.DB.prepare(
    `SELECT chat_id, title
     FROM groups
     WHERE authorized = 0
     ORDER BY updated_at DESC
     LIMIT 20`
  ).all();

  if (!(rows.results || []).length) {
    await sendMessage(
      env,
      chatId,
      `✅ No groups are waiting for approval.`
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    `<b>Groups waiting for approval</b>\n\n` +
    `Tap Approve for the group you want the bot to manage.`
  );

  for (const row of rows.results || []) {
    await sendMessage(
      env,
      chatId,
      `${escapeHtml(row.title || String(row.chat_id))}\n` +
      `<code>${row.chat_id}</code>`,
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "✅ Approve",
              callback_data: `approve:${row.chat_id}`,
            },
            {
              text: "❌ Reject",
              callback_data: `reject:${row.chat_id}`,
            },
          ]],
        },
      }
    );
  }
}

async function handleCallbackQuery(query, env) {
  const fromId = query.from?.id;

  if (!fromId || !isOwner(env, fromId)) {
    try {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Only the bot owner can approve groups.",
        show_alert: true,
      });
    } catch {}
    return;
  }

  const match = String(query.data || "").match(/^(approve|reject):(-?\d+)$/);

  if (!match) {
    try {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Unknown action.",
      });
    } catch {}
    return;
  }

  const action = match[1];
  const groupId = Number(match[2]);

  if (action === "reject") {
    await env.DB.prepare(
      `UPDATE groups
       SET authorized = 0, updated_at = ?
       WHERE chat_id = ?`
    ).bind(nowIso(), groupId).run();

    await audit(env, "group_rejected", {
      actorUserId: fromId,
      groupId,
    });

    await tg(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Group rejected.",
    });

    if (query.message) {
      await tg(env, "editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text:
          `<b>Group rejected ❌</b>\n\n` +
          `Group ID: <code>${groupId}</code>`,
        parse_mode: "HTML",
      });
    }

    return;
  }

  try {
    const chat = await tg(env, "getChat", { chat_id: groupId });
    const me = await tg(env, "getMe");
    const botMember = await getChatMember(env, groupId, me.id);

    const isAdmin =
      botMember.status === "administrator" ||
      botMember.status === "creator";

    const canDelete =
      botMember.status === "creator" ||
      Boolean(botMember.can_delete_messages);

    const canRestrict =
      botMember.status === "creator" ||
      Boolean(botMember.can_restrict_members);

    if (chat.type !== "supergroup" || !isAdmin || !canDelete || !canRestrict) {
      const missing = [];

      if (chat.type !== "supergroup") {
        missing.push("Group must be a supergroup");
      }

      if (!isAdmin) {
        missing.push("Bot must be an administrator");
      }

      if (!canDelete) {
        missing.push("Delete Messages permission");
      }

      if (!canRestrict) {
        missing.push("Ban/Restrict Members permission");
      }

      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Bot permissions are incomplete.",
        show_alert: true,
      });

      await sendMessage(
        env,
        ownerId(env),
        `<b>Cannot approve group yet</b>\n\n` +
        `${escapeHtml(chat.title || String(groupId))}\n\n` +
        missing.map(item => `• ${escapeHtml(item)}`).join("\n")
      );

      return;
    }

    await rememberGroup(env, chat);

    // Remove the old global "admins only can send" problem automatically.
    await setDefaultGroupSendingOn(env, groupId);

    await env.DB.prepare(
      `UPDATE groups
       SET authorized = 1,
           auto_restrict_new_members = 1,
           strict_enforcement = 1,
           delete_join_messages = 1,
           delete_controller_commands = 1,
           authorized_by = ?,
           authorized_at = ?,
           updated_at = ?
       WHERE chat_id = ?`
    ).bind(
      fromId,
      nowIso(),
      nowIso(),
      groupId
    ).run();

    await syncGlobalAllowlistToGroup(env, groupId);

    await audit(env, "group_approved", {
      actorUserId: fromId,
      groupId,
    });

    await tg(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Group approved.",
    });

    if (query.message) {
      await tg(env, "editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text:
          `<b>Group approved ✅</b>\n\n` +
          `${escapeHtml(chat.title || String(groupId))}\n` +
          `<code>${groupId}</code>\n\n` +
          `This group now uses your <b>global private allowlist</b>.\n\n` +
          `Send member IDs privately to this bot, one ID per line:\n\n` +
          `<code>8475307546\n8474567703\n8475365403</code>\n\n` +
          `Those IDs will be allowed in every approved group.`,
        parse_mode: "HTML",
      });
    }

    try {
      await sendMessage(
        env,
        groupId,
        `✅ <b>Bot activated</b>\n\n` +
        `This group uses the owner's global private allowlist.\n` +
        `Non-listed normal members remain read-only.`
      );
    } catch {}
  } catch (error) {
    console.error("Approval failed:", error);

    try {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Approval failed. Check bot admin permissions.",
        show_alert: true,
      });
    } catch {}

    try {
      await sendMessage(
        env,
        ownerId(env),
        `<b>Approval failed</b>\n\n${escapeHtml(safeError(error))}`
      );
    } catch {}
  }
}

function parseIdList(text) {
  if (!text) return null;

  const trimmed = text.trim();

  if (!trimmed) return null;

  // Owner control messages are intentionally strict:
  // digits + commas + spaces/newlines only.
  if (!/^[\d,\s]+$/.test(trimmed)) return null;

  const tokens = trimmed
    .split(/[\s,]+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!tokens.length || tokens.length > MAX_ID_LIST) return null;

  const ids = [];

  for (const token of tokens) {
    if (!/^\d{5,20}$/.test(token)) return null;

    const value = Number(token);

    if (!Number.isSafeInteger(value) || value <= 0) return null;

    if (!ids.includes(value)) {
      ids.push(value);
    }
  }

  return ids.length ? ids : null;
}

async function replaceGlobalAllowlistFromPrivateMessage(env, message, ids) {
  const actorId = message.from.id;

  await replaceGlobalAllowlist(env, ids, actorId);

  // The per-group table is now only a cache of permissions actually applied.
  // Clear old entries so removed IDs do not remain trusted.
  await env.DB.prepare(`DELETE FROM allowed_members`).run();

  const groups = await getAuthorizedGroups(env);

  let activated = 0;
  let restricted = 0;
  let groupsSynced = 0;

  for (const group of groups) {
    try {
      const result = await syncGlobalAllowlistToGroup(env, group.chat_id);
      activated += result.activated;
      restricted += result.restricted;
      groupsSynced += 1;
    } catch (error) {
      console.error(
        `Could not sync global allowlist to group ${group.chat_id}:`,
        safeError(error)
      );
    }
  }

  await audit(env, "global_allowlist_replaced", {
    actorUserId: actorId,
    details: {
      ids,
      groupsSynced,
      activated,
      restricted,
    },
  });

  const preview = ids
    .slice(0, 20)
    .map(id => `<code>${id}</code>`)
    .join("\\n");

  const more = ids.length > 20
    ? `\\n…and ${ids.length - 20} more`
    : "";

  await sendMessage(
    env,
    actorId,
    `<b>Global allowlist updated ✅</b>\\n\\n` +
    `Allowed IDs: <b>${ids.length}</b>\\n` +
    `Approved groups synced: <b>${groupsSynced}</b>\\n` +
    `Known current members enabled: <b>${activated}</b>\\n` +
    `Known non-listed members restricted: <b>${restricted}</b>\\n\\n` +
    `${preview}${more}\\n\\n` +
    `These IDs are now allowed to send in <b>every approved group</b>.\\n` +
    `If one of these IDs joins an approved group later, the bot will allow it automatically.\\n\\n` +
    `Send a new private ID list anytime to replace this master list.`
  );
}

async function syncGlobalAllowlistToGroup(env, groupId) {
  // Keep Telegram's default sending enabled. Individual restrictions are what
  // make non-allowlisted normal members read-only.
  try {
    await setDefaultGroupSendingOn(env, groupId);
  } catch (error) {
    console.warn(
      `Could not set default group permissions for ${groupId}:`,
      safeError(error)
    );
  }

  const rows = await env.DB.prepare(
    `SELECT
       km.user_id,
       km.is_bot,
       CASE WHEN gam.user_id IS NULL THEN 0 ELSE 1 END AS globally_allowed
     FROM known_members km
     LEFT JOIN global_allowed_members gam
       ON gam.user_id = km.user_id
     WHERE km.group_id = ?
     ORDER BY km.last_seen_at DESC`
  ).bind(groupId).all();

  let activated = 0;
  let restricted = 0;

  for (const row of rows.results || []) {
    const userId = Number(row.user_id);

    if (!userId || row.is_bot) continue;
    if (String(userId) === String(env.BOT_OWNER_ID)) continue;
    if (await isTelegramAdmin(env, groupId, userId)) continue;

    if (row.globally_allowed) {
      try {
        await upsertAllowId(env, groupId, userId, ownerId(env));
        activated += 1;
      } catch (error) {
        console.warn(
          `Could not enable globally allowed member ${userId} in ${groupId}:`,
          safeError(error)
        );
      }
    } else {
      try {
        const result = await makeReadOnly(
          env,
          groupId,
          userId,
          ownerId(env),
          "global_allowlist_enforcement"
        );

        if (result.ok) restricted += 1;
      } catch (error) {
        console.warn(
          `Could not restrict non-global member ${userId} in ${groupId}:`,
          safeError(error)
        );
      }
    }
  }

  return { activated, restricted };
}

async function restrictKnownNonAllowed(
  env,
  groupId,
  allowSet = null
) {
  const rows = await env.DB.prepare(
    `SELECT user_id, is_bot
     FROM known_members
     WHERE group_id = ?
     ORDER BY last_seen_at DESC
     LIMIT 100`
  ).bind(groupId).all();

  let restricted = 0;

  for (const row of rows.results || []) {
    const userId = Number(row.user_id);

    if (!userId || row.is_bot) continue;
    if (String(userId) === String(env.BOT_OWNER_ID)) continue;

    const isAllowed = allowSet
      ? allowSet.has(String(userId))
      : await isGlobalAllowedMember(env, userId);

    if (isAllowed) continue;

    try {
      if (await isTelegramAdmin(env, groupId, userId)) continue;

      const result = await makeReadOnly(
        env,
        groupId,
        userId,
        ownerId(env),
        "allowlist_enforcement"
      );

      if (result.ok) restricted += 1;
    } catch (error) {
      console.warn(
        `Could not restrict known member ${userId}:`,
        safeError(error)
      );
    }
  }

  return restricted;
}

async function handleChatMember(update, env) {
  const chat = update.chat;
  const user = update.new_chat_member?.user;

  if (!isGroupChat(chat) || !user?.id) return;

  await rememberGroup(env, chat);
  await rememberUser(env, chat.id, user);

  const oldPresent = present(
    update.old_chat_member?.status,
    update.old_chat_member
  );

  const newPresent = present(
    update.new_chat_member?.status,
    update.new_chat_member
  );

  if (!oldPresent && newPresent) {
    await processJoin(env, chat, user, "chat_member_join");
  }
}

async function handleMessage(message, env) {
  const chat = message.chat;
  const from = message.from;

  if (message.text?.startsWith("/")) {
    const handled = await handleSimpleCommand(message, env);
    if (handled) return;
  }

  // Owner maintains ONE master allowlist by sending plain IDs privately.
  // No command is required.
  if (
    chat?.type === "private" &&
    from?.id &&
    isOwner(env, from.id) &&
    typeof message.text === "string"
  ) {
    const ids = parseIdList(message.text);

    if (ids) {
      await replaceGlobalAllowlistFromPrivateMessage(env, message, ids);
      return;
    }
  }

  if (!isGroupChat(chat)) return;

  await rememberGroup(env, chat);

  if (from?.id) {
    await rememberUser(env, chat.id, from);
  }

  if (
    Array.isArray(message.new_chat_members) &&
    message.new_chat_members.length
  ) {
    for (const user of message.new_chat_members) {
      await processJoin(
        env,
        chat,
        user,
        "new_chat_members"
      );
    }

    const group = await getAuthorizedGroup(env, chat.id);

    if (group?.delete_join_messages) {
      await deleteMessageSafe(
        env,
        chat.id,
        message.message_id
      );
    }

    return;
  }

  const group = await getAuthorizedGroup(env, chat.id);

  if (!group) return;

  if (!from?.id || from.is_bot) return;

  if (String(from.id) === String(env.BOT_OWNER_ID)) return;

  if (await isTelegramAdmin(env, chat.id, from.id)) {
    return;
  }

  if (await isGlobalAllowedMember(env, from.id)) {
    // Normally the user was already unrestricted on join/list sync. If they
    // are globally allowed, never delete their message.
    return;
  }

  // Everyone else is enforced as read-only.
  await deleteMessageSafe(
    env,
    chat.id,
    message.message_id
  );

  try {
    await makeReadOnly(
      env,
      chat.id,
      from.id,
      null,
      "unapproved_sender"
    );
  } catch (error) {
    console.error(
      "Strict allowlist enforcement failed:",
      safeError(error)
    );
  }
}

async function handleSimpleCommand(message, env) {
  const text = String(message.text || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/whoami") {
    await sendMessage(
      env,
      message.chat.id,
      `<b>Your Telegram user ID</b>\n<code>${message.from.id}</code>`
    );
    return true;
  }

  if (command === "/start") {
    if (!isOwner(env, message.from.id)) {
      await sendMessage(
        env,
        message.chat.id,
        `This bot is privately controlled.\n\n` +
        `Your Telegram ID: <code>${message.from.id}</code>`
      );
      return true;
    }

    if (message.chat.type !== "private") {
      return true;
    }

    await sendMessage(
      env,
      message.chat.id,
      `<b>Global Allowlist Bot</b>\n\n` +
      `When this bot is added to a group, you will receive an approval button here.\n\n` +
      `To manage sending access, send the allowed Telegram user IDs <b>here privately</b>, one ID per line.\n\n` +
      `<code>8475307546\n8474567703\n8475365403</code>\n\n` +
      `That one master list applies to every approved group.`
    );

    await showPendingGroups(
      env,
      message.chat.id
    );

    return true;
  }

  if (command === "/help") {
    if (!isOwner(env, message.from.id)) {
      if (message.chat.type === "private") {
        await sendMessage(
          env,
          message.chat.id,
          `Access denied.`
        );
      }
      return true;
    }

    const help =
      `<b>Global Allowlist Bot</b>\n\n` +
      `<b>1. Add bot to a group</b>\n` +
      `Give it <b>Delete Messages</b> and <b>Ban/Restrict Members</b> admin permissions.\n\n` +
      `<b>2. Approve privately</b>\n` +
      `The bot sends the owner an Approve / Reject button here.\n\n` +
      `<b>3. Send the master ID list PRIVATELY to this bot</b>\n\n` +
      `<code>8475307546\n8474567703\n8475365403</code>\n\n` +
      `No command is needed. A new private list completely replaces the previous global allowlist.\n\n` +
      `<b>4. Global enforcement</b>\n` +
      `Listed IDs can send in every approved group.\n` +
      `If a listed ID joins another approved group later, it is allowed automatically.\n` +
      `All other normal members are read-only.\n` +
      `Join notices are deleted automatically.\n\n` +
      `<b>Important</b>\n` +
      `Telegram group administrators cannot be restricted by a bot. Anyone who should follow this allowlist must remain a normal member.\n\n` +
      `<code>/start</code> — show pending groups\n` +
      `<code>/help</code> — show this guide\n` +
      `<code>/whoami</code> — show your Telegram ID`;
    if (message.chat.type === "private") {
      await sendMessage(
        env,
        message.chat.id,
        help
      );
    } else {
      try {
        await sendMessage(
          env,
          message.from.id,
          help
        );
      } catch {}
    }

    return true;
  }

  return false;
}
