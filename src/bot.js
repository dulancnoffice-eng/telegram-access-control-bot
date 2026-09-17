import {
  audit,
  cacheAllowedMember,
  ensureGlobalAllowlistSchema,
  getAuthorizedGroup,
  getAuthorizedGroups,
  getGlobalAllowlist,
  getKnownMembersWithGlobalState,
  getPendingGroups,
  isGlobalAllowedMember,
  isOwner,
  rememberGroup,
  rememberUser,
  removeAllowedMemberCache,
  replaceGlobalAllowlist,
  setGroupAuthorized,
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
  safeError,
} from "./util.js";

const MAX_ID_LIST = 100;

export async function handleUpdate(update, env, ctx) {
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query, env, ctx);
  }

  if (update.my_chat_member) {
    return handleMyChatMember(update.my_chat_member, env);
  }

  if (update.chat_member) {
    return handleChatMember(update.chat_member, env);
  }

  if (update.message) {
    return handleMessage(update.message, env, ctx);
  }
}

function ownerId(env) {
  return Number(env.BOT_OWNER_ID);
}

function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function memberIsPresent(member) {
  if (!member) return false;

  if (["creator", "administrator", "member"].includes(member.status)) {
    return true;
  }

  if (member.status === "restricted") {
    return Boolean(member.is_member);
  }

  return false;
}

function parseIdList(text) {
  if (!text) return null;

  const trimmed = String(text).trim();
  if (!trimmed) return null;

  // Plain numeric IDs only, separated by whitespace or comma.
  if (!/^[\d,\s]+$/.test(trimmed)) return null;

  const tokens = trimmed
    .split(/[\s,]+/)
    .map(v => v.trim())
    .filter(Boolean);

  if (!tokens.length || tokens.length > MAX_ID_LIST) {
    return null;
  }

  const ids = [];

  for (const token of tokens) {
    if (!/^\d{5,20}$/.test(token)) return null;

    const id = Number(token);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return null;
    }

    if (!ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids.length ? ids : null;
}

async function handleMessage(message, env, ctx) {
  const chat = message.chat;
  const from = message.from;

  // Commands are intentionally handled FIRST and do not wait for
  // allowlist/group synchronization.
  if (message.text?.startsWith("/")) {
    const handled = await handleCommand(message, env);
    if (handled) return;
  }

  // Owner sends the master allowlist privately, with no command.
  if (
    chat?.type === "private" &&
    from?.id &&
    isOwner(env, from.id) &&
    typeof message.text === "string"
  ) {
    const ids = parseIdList(message.text);

    if (ids) {
      await saveOwnerGlobalAllowlist(message, ids, env, ctx);
      return;
    }
  }

  if (!isGroupChat(chat)) return;

  await rememberGroup(env, chat);

  if (from?.id) {
    await rememberUser(env, chat.id, from);
  }

  // Telegram join service message.
  if (
    Array.isArray(message.new_chat_members) &&
    message.new_chat_members.length
  ) {
    for (const user of message.new_chat_members) {
      await handleJoinedUser(env, chat, user);
    }

    const group = await getAuthorizedGroup(env, chat.id);

    if (group?.delete_join_messages) {
      await deleteMessageSafe(env, chat.id, message.message_id);
    }

    return;
  }

  const group = await getAuthorizedGroup(env, chat.id);
  if (!group) return;

  if (!from?.id || from.is_bot) return;

  if (String(from.id) === String(env.BOT_OWNER_ID)) {
    return;
  }

  if (await isTelegramAdmin(env, chat.id, from.id)) {
    return;
  }

  if (await isGlobalAllowedMember(env, from.id)) {
    return;
  }

  // Unknown/old non-allowed member got one message through.
  // Remove that message and make the member read-only immediately.
  await deleteMessageSafe(env, chat.id, message.message_id);

  try {
    await restrictUser(env, chat.id, from.id, "strict_enforcement");
  } catch (error) {
    console.error("Strict enforcement failed:", safeError(error));
  }
}

async function handleCommand(message, env) {
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
    if (message.chat.type !== "private") {
      return true;
    }

    if (!isOwner(env, message.from.id)) {
      await sendMessage(
        env,
        message.chat.id,
        `This bot is privately controlled.\n\n` +
        `Your Telegram ID: <code>${message.from.id}</code>`
      );
      return true;
    }

    // Always acknowledge /start before touching D1.
    await sendMessage(
      env,
      message.chat.id,
      `<b>Global Allowlist Bot is online ✅</b>\n\n` +
      `Send your allowed Telegram user IDs here privately, one per line.\n\n` +
      `<code>8475307546\n8474567703\n8475365403</code>\n\n` +
      `That single list applies to every approved group.`
    );

    try {
      await showPendingGroups(env, message.chat.id);
    } catch (error) {
      console.error("Could not show pending groups:", safeError(error));

      await sendMessage(
        env,
        message.chat.id,
        `⚠️ The bot is online, but I could not read the pending-group list right now.\n` +
        `<code>${escapeHtml(safeError(error))}</code>`
      );
    }

    return true;
  }

  if (command === "/help") {
    if (message.chat.type !== "private") {
      return true;
    }

    if (!isOwner(env, message.from.id)) {
      await sendMessage(env, message.chat.id, `Access denied.`);
      return true;
    }

    await sendMessage(
      env,
      message.chat.id,
      `<b>Global Allowlist Bot</b>\n\n` +
      `<b>Group setup</b>\n` +
      `1. Add the bot to a Telegram <b>supergroup</b>.\n` +
      `2. Make it administrator with <b>Delete Messages</b> and <b>Ban/Restrict Members</b>.\n` +
      `3. Approve the group from the private Approve button.\n\n` +
      `<b>Master posting list</b>\n` +
      `Send IDs privately to this bot, one ID per line:\n\n` +
      `<code>8475307546\n8474567703\n8475365403</code>\n\n` +
      `A new list replaces the previous list.\n` +
      `Listed normal members can send in every approved group.\n` +
      `Non-listed normal members are read-only.\n` +
      `Listed IDs that join later are allowed automatically.\n\n` +
      `<b>Commands</b>\n` +
      `<code>/start</code> — bot status + pending groups\n` +
      `<code>/help</code> — this guide\n` +
      `<code>/whoami</code> — show your Telegram user ID\n\n` +
      `<i>Telegram group administrators cannot be restricted by this bot.</i>`
    );

    return true;
  }

  return false;
}

async function saveOwnerGlobalAllowlist(message, ids, env, ctx) {
  try {
    const result = await replaceGlobalAllowlist(
      env,
      ids,
      message.from.id
    );

    const groups = await getAuthorizedGroups(env);

    // Reply immediately. Do NOT make the owner wait for Telegram member API calls.
    await sendMessage(
      env,
      message.chat.id,
      `<b>Global allowlist saved ✅</b>\n\n` +
      `Allowed IDs: <b>${result.ids.length}</b>\n` +
      `Approved groups: <b>${groups.length}</b>\n\n` +
      `I am syncing those permissions in the background now.`
    );

    const syncTask = syncAllGroups(
      env,
      groups,
      result.ids,
      result.removedIds,
      message.from.id
    ).then(async summary => {
      try {
        await sendMessage(
          env,
          message.chat.id,
          `<b>Permission sync complete ✅</b>\n\n` +
          `Groups synced: <b>${summary.groupsSynced}</b>\n` +
          `Listed current members enabled: <b>${summary.enabled}</b>\n` +
          `Removed/non-listed known members restricted: <b>${summary.restricted}</b>`
        );
      } catch {}
    }).catch(error => {
      console.error("Background allowlist sync failed:", safeError(error));
    });

    if (ctx?.waitUntil) {
      ctx.waitUntil(syncTask);
    } else {
      await syncTask;
    }

    await audit(env, "global_allowlist_saved", {
      actorUserId: message.from.id,
      details: {
        ids: result.ids,
        removedIds: result.removedIds,
      },
    });
  } catch (error) {
    console.error("Saving global allowlist failed:", safeError(error));

    await sendMessage(
      env,
      message.chat.id,
      `<b>Could not save the global allowlist</b>\n\n` +
      `<code>${escapeHtml(safeError(error))}</code>`
    );
  }
}

async function syncAllGroups(env, groups, allowedIds, removedIds, actorUserId) {
  let groupsSynced = 0;
  let enabled = 0;
  let restricted = 0;

  for (const group of groups) {
    try {
      const result = await syncGroupPermissions(
        env,
        Number(group.chat_id),
        allowedIds,
        removedIds,
        actorUserId
      );

      groupsSynced += 1;
      enabled += result.enabled;
      restricted += result.restricted;
    } catch (error) {
      console.error(
        `Sync failed for group ${group.chat_id}:`,
        safeError(error)
      );
    }
  }

  return { groupsSynced, enabled, restricted };
}

async function syncGroupPermissions(
  env,
  groupId,
  allowedIds,
  removedIds,
  actorUserId
) {
  let enabled = 0;
  let restricted = 0;

  // Normal group members need the group-wide baseline to allow sending;
  // individual restrictions then block everybody who is not approved.
  await setDefaultGroupSendingOn(env, groupId);

  // Directly check EVERY globally allowed ID against Telegram.
  // This works even if the bot never cached that member previously.
  for (const userId of allowedIds) {
    try {
      const member = await getChatMember(env, groupId, userId);

      if (!memberIsPresent(member)) {
        continue;
      }

      if (member.status === "creator" || member.status === "administrator") {
        if (member.user) {
          await rememberUser(env, groupId, member.user);
        }
        continue;
      }

      await allowUser(env, groupId, member.user || { id: userId }, actorUserId);
      enabled += 1;
    } catch (error) {
      // Not in this group yet, or Telegram cannot resolve it here.
      // Keep it in the global table. Join handling will grant access later.
      console.log(
        `Allowed ID ${userId} is not currently active in group ${groupId}:`,
        safeError(error)
      );
    }
  }

  // IDs removed from the master list must lose posting access immediately
  // if they are current normal members.
  for (const userId of removedIds) {
    try {
      const member = await getChatMember(env, groupId, userId);

      if (!memberIsPresent(member)) continue;
      if (member.status === "creator" || member.status === "administrator") continue;

      await restrictUser(env, groupId, userId, "removed_from_global_allowlist");
      restricted += 1;
    } catch {}
  }

  // Also restrict every known normal member not present in the global table.
  const known = await getKnownMembersWithGlobalState(env, groupId);

  for (const row of known) {
    const userId = Number(row.user_id);

    if (!userId || row.is_bot) continue;
    if (String(userId) === String(env.BOT_OWNER_ID)) continue;
    if (row.globally_allowed) continue;

    try {
      if (await isTelegramAdmin(env, groupId, userId)) continue;

      await restrictUser(env, groupId, userId, "global_allowlist_enforcement");
      restricted += 1;
    } catch {}
  }

  return { enabled, restricted };
}

async function handleJoinedUser(env, chat, user) {
  if (!user?.id || user.is_bot) return;

  await rememberUser(env, chat.id, user);

  const group = await getAuthorizedGroup(env, chat.id);
  if (!group) return;

  if (String(user.id) === String(env.BOT_OWNER_ID)) return;
  if (await isTelegramAdmin(env, chat.id, user.id)) return;

  if (await isGlobalAllowedMember(env, user.id)) {
    await allowUser(env, chat.id, user, ownerId(env));
    return;
  }

  await restrictUser(env, chat.id, user.id, "new_member_not_allowlisted");
}

async function handleChatMember(update, env) {
  const chat = update.chat;
  const oldMember = update.old_chat_member;
  const newMember = update.new_chat_member;
  const user = newMember?.user;

  if (!isGroupChat(chat) || !user?.id) return;

  await rememberGroup(env, chat);
  await rememberUser(env, chat.id, user);

  const wasPresent = memberIsPresent(oldMember);
  const isPresentNow = memberIsPresent(newMember);

  if (!wasPresent && isPresentNow) {
    try {
      await handleJoinedUser(env, chat, user);
    } catch (error) {
      console.error("Join permission handling failed:", safeError(error));
    }
  }
}

async function handleMyChatMember(update, env) {
  const chat = update.chat;

  if (!isGroupChat(chat)) return;

  await rememberGroup(env, chat);

  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;

  const becamePresent =
    ["left", "kicked"].includes(oldStatus) &&
    !["left", "kicked"].includes(newStatus);

  const becameAdmin =
    newStatus === "administrator" &&
    oldStatus !== "administrator";

  if (!becamePresent && !becameAdmin) {
    return;
  }

  const existing = await getAuthorizedGroup(env, chat.id);

  if (!existing) {
    await notifyOwnerForApproval(env, chat);
  }
}

async function notifyOwnerForApproval(env, chat) {
  const text =
    `<b>Bot added to a group</b>\n\n` +
    `Group: ${escapeHtml(chat.title || String(chat.id))}\n` +
    `Group ID: <code>${chat.id}</code>\n\n` +
    `Approve this group?`;

  try {
    await sendMessage(
      env,
      ownerId(env),
      text,
      {
        reply_markup: {
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
        },
      }
    );
  } catch (error) {
    console.error("Could not DM owner:", safeError(error));

    try {
      await sendMessage(
        env,
        chat.id,
        `⚠️ Open the bot privately from the owner account and press Start.`
      );
    } catch {}
  }
}

async function showPendingGroups(env, ownerChatId) {
  const rows = await getPendingGroups(env);

  if (!rows.length) {
    await sendMessage(
      env,
      ownerChatId,
      `✅ No groups are waiting for approval.`
    );
    return;
  }

  await sendMessage(
    env,
    ownerChatId,
    `<b>Groups waiting for approval</b>`
  );

  for (const group of rows) {
    await sendMessage(
      env,
      ownerChatId,
      `${escapeHtml(group.title || String(group.chat_id))}\n` +
      `<code>${group.chat_id}</code>`,
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "✅ Approve",
              callback_data: `approve:${group.chat_id}`,
            },
            {
              text: "❌ Reject",
              callback_data: `reject:${group.chat_id}`,
            },
          ]],
        },
      }
    );
  }
}

async function handleCallbackQuery(query, env, ctx) {
  const actorId = query.from?.id;

  // Stop Telegram's spinner immediately, before any D1 or group API work.
  try {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: isOwner(env, actorId) ? "Processing…" : "Owner only.",
      show_alert: !isOwner(env, actorId),
    });
  } catch {}

  if (!actorId || !isOwner(env, actorId)) {
    return;
  }

  const match = String(query.data || "").match(/^(approve|reject):(-?\d+)$/);

  if (!match) return;

  const action = match[1];
  const groupId = Number(match[2]);

  if (action === "reject") {
    // Store a permanent rejected state:
    //   1  = approved
    //   0  = waiting for owner approval
    //  -1  = rejected by owner
    //
    // getPendingGroups() only selects authorized = 0, so rejected groups
    // will no longer reappear every time the owner sends /start.
    await env.DB.prepare(
      `UPDATE groups
       SET authorized = -1,
           updated_at = datetime('now')
       WHERE chat_id = ?`
    ).bind(groupId).run();

    await audit(env, "group_rejected", {
      actorUserId: actorId,
      groupId,
    });

    if (query.message) {
      try {
        await tg(env, "editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text:
            `<b>Group rejected ❌</b>\n\n` +
            `Group ID: <code>${groupId}</code>\n\n` +
            `<i>This group will not appear in the pending list again.</i>`,
          parse_mode: "HTML",
        });
      } catch {}
    }

    return;
  }

  try {
    await ensureGlobalAllowlistSchema(env);

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

    if (missing.length) {
      await sendMessage(
        env,
        ownerId(env),
        `<b>Cannot approve group yet</b>\n\n` +
        `${escapeHtml(chat.title || String(groupId))}\n\n` +
        missing.map(item => `• ${escapeHtml(item)}`).join("\n")
      );

      return;
    }

    // Fix the old "admins only can send" global permission.
    await setDefaultGroupSendingOn(env, groupId);

    await rememberGroup(env, chat);
    await setGroupAuthorized(env, groupId, true, actorId);

    if (query.message) {
      try {
        await tg(env, "editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text:
            `<b>Group approved ✅</b>\n\n` +
            `${escapeHtml(chat.title || String(groupId))}\n` +
            `<code>${groupId}</code>\n\n` +
            `This group now uses your private global allowlist.`,
          parse_mode: "HTML",
        });
      } catch {}
    }

    try {
      await sendMessage(
        env,
        groupId,
        `✅ <b>Access Control Bot activated</b>\n` +
        `Only globally allowlisted normal members can post.`
      );
    } catch {}

    const allowedRows = await getGlobalAllowlist(env);
    const allowedIds = allowedRows.map(row => Number(row.user_id));

    const task = syncGroupPermissions(
      env,
      groupId,
      allowedIds,
      [],
      actorId
    ).catch(error => {
      console.error("Initial group sync failed:", safeError(error));
    });

    if (ctx?.waitUntil) {
      ctx.waitUntil(task);
    } else {
      await task;
    }

    await audit(env, "group_approved", {
      actorUserId: actorId,
      groupId,
    });
  } catch (error) {
    console.error("Approval failed:", safeError(error));

    try {
      await sendMessage(
        env,
        ownerId(env),
        `<b>Approval failed</b>\n\n` +
        `<code>${escapeHtml(safeError(error))}</code>`
      );
    } catch {}
  }
}

async function setDefaultGroupSendingOn(env, groupId) {
  await tg(env, "setChatPermissions", {
    chat_id: groupId,
    permissions: allowedSendPermissions(),
    use_independent_chat_permissions: true,
  });
}

async function allowUser(env, groupId, user, actorUserId) {
  const userId = Number(user?.id);

  if (!userId) return false;

  await tg(env, "restrictChatMember", {
    chat_id: groupId,
    user_id: userId,
    permissions: allowedSendPermissions(),
    use_independent_chat_permissions: true,
  });

  await rememberUser(env, groupId, user);
  await cacheAllowedMember(env, groupId, user, actorUserId);

  return true;
}

async function restrictUser(env, groupId, userId, reason) {
  if (String(userId) === String(env.BOT_OWNER_ID)) {
    return false;
  }

  if (await isTelegramAdmin(env, groupId, userId)) {
    return false;
  }

  await tg(env, "restrictChatMember", {
    chat_id: groupId,
    user_id: userId,
    permissions: readonlyPermissions(),
    use_independent_chat_permissions: true,
  });

  await removeAllowedMemberCache(env, groupId, userId);

  await audit(env, "member_restricted", {
    groupId,
    targetUserId: userId,
    details: { reason },
  });

  return true;
}
