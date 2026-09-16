import { nowIso } from "./util.js";

export function isOwner(env, userId) {
  return String(userId) === String(env.BOT_OWNER_ID);
}

export async function ensureGlobalAllowlistSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS global_allowed_members (
      user_id INTEGER PRIMARY KEY,
      added_by INTEGER NOT NULL,
      added_at TEXT NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_global_allowed_members_added_at
     ON global_allowed_members (added_at)`
  ).run();
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
      action,
      actorUserId,
      groupId,
      targetUserId,
      details ? JSON.stringify(details) : null,
      nowIso()
    ).run();
  } catch (error) {
    console.error("Audit failed:", error?.message || error);
  }
}

export async function rememberGroup(env, chat) {
  if (!chat?.id) return;

  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO groups
      (chat_id, title, chat_type, authorized,
       auto_restrict_new_members, strict_enforcement,
       delete_join_messages, delete_controller_commands,
       created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, 1, 1, 1, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title,
       chat_type = excluded.chat_type,
       updated_at = excluded.updated_at`
  ).bind(
    chat.id,
    chat.title || String(chat.id),
    chat.type || "unknown",
    now,
    now
  ).run();
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
    groupId,
    user.id,
    user.username || "",
    user.first_name || "",
    user.last_name || "",
    user.is_bot ? 1 : 0,
    nowIso()
  ).run();
}

export async function getGroup(env, groupId) {
  return env.DB.prepare(
    `SELECT * FROM groups WHERE chat_id = ?`
  ).bind(groupId).first();
}

export async function getAuthorizedGroup(env, groupId) {
  return env.DB.prepare(
    `SELECT * FROM groups
     WHERE chat_id = ? AND authorized = 1`
  ).bind(groupId).first();
}

export async function getPendingGroups(env) {
  const rows = await env.DB.prepare(
    `SELECT chat_id, title
     FROM groups
     WHERE authorized = 0
     ORDER BY updated_at DESC
     LIMIT 30`
  ).all();

  return rows.results || [];
}

export async function getAuthorizedGroups(env) {
  const rows = await env.DB.prepare(
    `SELECT chat_id, title
     FROM groups
     WHERE authorized = 1
     ORDER BY title`
  ).all();

  return rows.results || [];
}

export async function setGroupAuthorized(env, groupId, authorized, actorUserId = null) {
  await env.DB.prepare(
    `UPDATE groups
     SET authorized = ?,
         authorized_by = CASE WHEN ? = 1 THEN ? ELSE authorized_by END,
         authorized_at = CASE WHEN ? = 1 THEN ? ELSE authorized_at END,
         updated_at = ?
     WHERE chat_id = ?`
  ).bind(
    authorized ? 1 : 0,
    authorized ? 1 : 0,
    actorUserId,
    authorized ? 1 : 0,
    nowIso(),
    nowIso(),
    groupId
  ).run();
}

export async function isGlobalAllowedMember(env, userId) {
  await ensureGlobalAllowlistSchema(env);

  return Boolean(await env.DB.prepare(
    `SELECT 1
     FROM global_allowed_members
     WHERE user_id = ?`
  ).bind(userId).first());
}

export async function getGlobalAllowlist(env) {
  await ensureGlobalAllowlistSchema(env);

  const rows = await env.DB.prepare(
    `SELECT user_id, added_by, added_at
     FROM global_allowed_members
     ORDER BY user_id`
  ).all();

  return rows.results || [];
}

export async function replaceGlobalAllowlist(env, userIds, actorUserId) {
  await ensureGlobalAllowlistSchema(env);

  const ids = [...new Set(
    (userIds || [])
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)
  )];

  const previous = await getGlobalAllowlist(env);
  const previousIds = previous.map(row => Number(row.user_id));

  const statements = [
    env.DB.prepare(`DELETE FROM global_allowed_members`)
  ];

  const addedAt = nowIso();

  for (const userId of ids) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO global_allowed_members
         (user_id, added_by, added_at)
         VALUES (?, ?, ?)`
      ).bind(userId, actorUserId, addedAt)
    );
  }

  await env.DB.batch(statements);

  return {
    ids,
    previousIds,
    removedIds: previousIds.filter(id => !ids.includes(id)),
  };
}

export async function cacheAllowedMember(env, groupId, user, actorUserId) {
  const userId = Number(user?.id);

  if (!userId) return;

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
}

export async function removeAllowedMemberCache(env, groupId, userId) {
  await env.DB.prepare(
    `DELETE FROM allowed_members
     WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).run();
}

export async function getKnownMembersWithGlobalState(env, groupId) {
  await ensureGlobalAllowlistSchema(env);

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

  return rows.results || [];
}
