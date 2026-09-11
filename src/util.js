export const VERSION = "4.0.0";

export function nowIso() {
  return new Date().toISOString();
}

export function toId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function userLabel(user) {
  if (!user) return "Unknown";
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return user.username ? `${full || "User"} (@${user.username})` : (full || String(user.id || "Unknown"));
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}
