import { safeError } from "./util.js";

export async function tg(env, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${method}: Telegram returned a non-JSON response`);
  }

  if (!data.ok) {
    throw new Error(`${method}: ${data.error_code || res.status} ${data.description || "Telegram API error"}`);
  }
  return data.result;
}

export async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function deleteMessageSafe(env, chatId, messageId) {
  try {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    return true;
  } catch (error) {
    console.warn("deleteMessage failed:", safeError(error));
    return false;
  }
}

export async function getChatMember(env, chatId, userId) {
  return tg(env, "getChatMember", { chat_id: chatId, user_id: userId });
}

export async function isTelegramAdmin(env, chatId, userId) {
  try {
    const m = await getChatMember(env, chatId, userId);
    return m.status === "creator" || m.status === "administrator";
  } catch {
    return false;
  }
}

export function readonlyPermissions() {
  return {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
    can_manage_topics: false,
  };
}

export function allowedSendPermissions() {
  return {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
    can_manage_topics: false,
  };
}
