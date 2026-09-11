import { nowIso } from "./util.js";

export async function claimUpdate(env, updateId) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO processed_updates (update_id, claimed_at) VALUES (?, ?)`
  ).bind(updateId, nowIso()).run();
  return Number(r?.meta?.changes || 0) > 0;
}

export async function releaseUpdate(env, updateId) {
  try {
    await env.DB.prepare(`DELETE FROM processed_updates WHERE update_id = ?`).bind(updateId).run();
  } catch {}
}

export async function audit(env, action, {
  actorUserId = null,
  groupId = null,
  targetUserId = null,
  details = null,
} = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs
       (action, actor_user_id, group_id, target_user_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      action, actorUserId, groupId, targetUserId,
      details ? JSON.stringify(details) : null,
      nowIso()
    ).run();
  } catch (e) {
    console.error("Audit failed:", e?.message || e);
  }
}

export async function rememberGroup(env, chat) {
  if (!chat?.id) return;
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO groups
      (chat_id, title, chat_type, authorized, auto_restrict_new_members,
       strict_enforcement, delete_join_messages, delete_controller_commands,
       created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, 1, 1, 1, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title,
       chat_type = excluded.chat_type,
       updated_at = excluded.updated_at`
  ).bind(chat.id, chat.title || String(chat.id), chat.type || "unknown", now, now).run();
}

export async function getGroup(env, groupId) {
  return env.DB.prepare(`SELECT * FROM groups WHERE chat_id = ?`).bind(groupId).first();
}

export async function getAuthorizedGroup(env, groupId) {
  return env.DB.prepare(`SELECT * FROM groups WHERE chat_id = ? AND authorized = 1`).bind(groupId).first();
}

export async function rememberUser(env, groupId, user) {
  if (!groupId || !user?.id) return;
  await env.DB.prepare(
    `INSERT INTO known_members
      (group_id, user_id, username, first_name, last_name, is_bot, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       is_bot = excluded.is_bot,
       last_seen_at = excluded.last_seen_at`
  ).bind(
    groupId, user.id, user.username || "", user.first_name || "",
    user.last_name || "", user.is_bot ? 1 : 0, nowIso()
  ).run();
}

export function isOwner(env, userId) {
  return String(userId) === String(env.BOT_OWNER_ID);
}

export async function isGlobalController(env, userId) {
  if (isOwner(env, userId)) return true;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM controllers WHERE user_id = ?`).bind(userId).first());
}

export async function isGroupController(env, groupId, userId) {
  if (await isGlobalController(env, userId)) return true;
  return Boolean(await env.DB.prepare(
    `SELECT 1 FROM group_controllers WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).first());
}

export async function canManageGroup(env, groupId, userId) {
  const g = await getAuthorizedGroup(env, groupId);
  return Boolean(g) && await isGroupController(env, groupId, userId);
}

export async function isAllowedMember(env, groupId, userId) {
  return Boolean(await env.DB.prepare(
    `SELECT 1 FROM allowed_members WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).first());
}
