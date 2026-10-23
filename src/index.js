const TELEGRAM_API = "https://api.telegram.org/bot";

export default {
  async fetch(request, env) {
    // The webhook secret is mandatory. Fail closed if it was not configured.
    if (!env.WEBHOOK_SECRET) {
      return new Response("Webhook is not configured", { status: 503 });
    }

    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!constantTimeEqual(suppliedSecret, env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Avoid parsing unexpectedly large bodies. Telegram updates are normally small.
    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (contentLength > 1024 * 1024) {
      return new Response("Payload Too Large", { status: 413 });
    }

    try {
      const rawBody = await request.text();
      if (rawBody.length > 1024 * 1024) {
        return new Response("Payload Too Large", { status: 413 });
      }
      const update = JSON.parse(rawBody);
      await handleUpdate(update, env);
      return new Response("OK");
    } catch {
      // Do not log request bodies, messages, user data, or exception details.
      // A generic response avoids exposing internal implementation details.
      return new Response("Bad Request", { status: 400 });
    }
  },
};

function constantTimeEqual(a, b) {
  // Compare all characters without returning early on the first mismatch.
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat || !msg.from) return;

  const chat = msg.chat;
  const text = msg.text || msg.caption || "";
  const isPrivate = chat.type === "private";
  const isGroup = ["group", "supergroup"].includes(chat.type);
  const admin = isAdmin(msg.from.id, env);

  // /save: private chat, bot admin only
  if (isPrivate && msg.text?.startsWith("/save")) {
    if (!admin) {
      return sendMessage(env, chat.id, "❌ شما اجازه استفاده از /save را ندارید.");
    }
    const parts = msg.text.trim().split(/\s+/);
    if (parts.length !== 2 || !parts[1].startsWith("/")) {
      return sendMessage(env, chat.id, "فرمت صحیح:\n/save /test\n\nسپس پیام موردنظر را در همین PV ارسال کنید.");
    }
    const command = normalizeCommand(parts[1]);
    await env.SHAHED_KV.put(`pending_save:${msg.from.id}`, JSON.stringify({
      command, createdAt: Date.now()
    }), { expirationTtl: 600 });
    return sendMessage(env, chat.id, `✅ کامند ${command} آماده ذخیره است.\nحالا پیام موردنظر را در همین PV ارسال کنید.`);
  }

  // Capture the next private message after /save
  if (isPrivate && admin) {
    const pending = await env.SHAHED_KV.get(`pending_save:${msg.from.id}`, "json");
    if (pending && !msg.text?.startsWith("/save")) {
      const payload = await buildSavedMessage(msg);
      if (!payload) {
        return sendMessage(env, chat.id, "❌ این نوع پیام فعلاً برای /save پشتیبانی نمی‌شود.");
      }
      await env.SHAHED_KV.put(`saved:${pending.command}`, JSON.stringify(payload));
      await env.SHAHED_KV.delete(`pending_save:${msg.from.id}`);
      return sendMessage(env, chat.id, `✅ ذخیره شد.\nبرای استفاده:\n${pending.command}`);
    }
  }

  if (!isGroup) return;

  // Admin group commands
  if (msg.text?.startsWith("/gm")) {
    if (!admin) {
      return sendMessage(env, chat.id, "❌ فقط ادمین شاهد می‌تواند از /gm استفاده کند.");
    }
    return handleGM(msg, env);
  }

  // Archive the message replied to, into the configured channel
  if (msg.text?.split(/\s+/)[0]?.split("@")[0] === "/archive") {
    if (!admin) {
      return sendMessage(env, chat.id, "❌ فقط ادمین شاهد می‌تواند از /archive استفاده کند.");
    }
    if (!msg.reply_to_message) {
      return sendMessage(env, chat.id, "❌ دستور /archive را با Reply روی پیام موردنظر بفرست.");
    }
    if (!env.ARCHIVE_CHANNEL_ID) {
      return sendMessage(env, chat.id, "❌ مقصد آرشیو تنظیم نشده است. مقدار ARCHIVE_CHANNEL_ID را در Cloudflare تنظیم کن.");
    }
    const result = await tg(env, "forwardMessage", {
      chat_id: env.ARCHIVE_CHANNEL_ID,
      from_chat_id: chat.id,
      message_id: msg.reply_to_message.message_id
    });
    if (!result.ok) return sendTelegramError(env, chat.id, result);
    return sendMessage(env, chat.id, "📦 پیام به کانال آرشیو فرستاده شد.");
  }

  // Filter checks: process ordinary group messages (including captions).
  
  // بررسی فیلتر کلمات با امکان معافیت کاربران
  if (!admin && !msg.from.is_bot && text) {
    const exemptUsers =
      (await env.SHAHED_KV.get(
        `filter_exempt:${chat.id}`,
        "json"
      )) || [];

    const isExempt = exemptUsers.includes(
      String(msg.from.id)
    );

    if (!isExempt) {
      const filters =
        (await env.SHAHED_KV.get(
          `filters:${chat.id}`,
          "json"
        )) || [];

      const normalizedText = text.toLocaleLowerCase();

      const matched = filters.find(word =>
        normalizedText.includes(
          word.toLocaleLowerCase()
        )
      );

      if (matched) {
        const deleted = await tg(env, "deleteMessage", {
          chat_id: chat.id,
          message_id: msg.message_id
        });

        if (!deleted.ok) return;

        await addWarning(
          env,
          chat.id,
          msg.from.id,
          msg.from,
          `پیام به‌دلیل استفاده از کلمه فیلترشده «${matched}» حذف شد.`
        );

        return;
      }
    }
  }

  // Saved commands are available to everyone
  if (msg.text?.startsWith("/")) {
    const command = normalizeCommand(msg.text.trim().split(/\s+/)[0]);
    if (!command || ["/gm", "/archive"].includes(command)) return;
    const saved = await env.SHAHED_KV.get(`saved:${command}`, "json");
    if (saved) return sendSavedMessage(env, chat.id, saved, msg.message_id);
  }
}

function isAdmin(userId, env) {
  if (!userId || !env.ADMIN_IDS) return false;
  return env.ADMIN_IDS.split(",").map(x => x.trim()).filter(Boolean).includes(String(userId));
}

function normalizeCommand(command) {
  if (!command) return "";
  const clean = command.trim().split("@")[0];
  return clean.startsWith("/") ? clean.toLowerCase() : "";
}

async function handleGM(msg, env) {
  const chatId = msg.chat.id;
  const raw = msg.text.trim();
  const args = raw.split(/\s+/);
  const target = msg.reply_to_message?.from;
  const targetMessage = msg.reply_to_message;

  // /gm تنظیم فیلتر(کلمه)
  const setFilter = raw.match(/^\/gm\s+تنظیم\s+فیلتر\((.+)\)\s*$/i);
  if (setFilter) {
    const word = setFilter[1].trim();
    if (!word) return sendMessage(env, chatId, "❌ کلمه فیلتر نمی‌تواند خالی باشد.");
    const key = `filters:${chatId}`;
    const filters = await env.SHAHED_KV.get(key, "json") || [];
    if (filters.some(x => x.toLocaleLowerCase() === word.toLocaleLowerCase())) {
      return sendMessage(env, chatId, `ℹ️ «${word}» از قبل فیلتر شده است.`);
    }
    filters.push(word);
    await env.SHAHED_KV.put(key, JSON.stringify(filters));
    return sendMessage(env, chatId, `✅ فیلتر «${word}» فعال شد.\nپیام‌های حاوی این کلمه حذف می‌شوند و به فرستنده اخطار می‌رسد.`);
  }

  // Optional matching command to remove a filter
  const removeFilter = raw.match(/^\/gm\s+لغو\s+فیلتر\((.+)\)\s*$/i);
  if (removeFilter) {
    const word = removeFilter[1].trim();
    const key = `filters:${chatId}`;
    const filters = await env.SHAHED_KV.get(key, "json") || [];
    const next = filters.filter(x => x.toLocaleLowerCase() !== word.toLocaleLowerCase());
    if (next.length === filters.length) {
      return sendMessage(env, chatId, `ℹ️ فیلتر «${word}» پیدا نشد.`);
    }
    await env.SHAHED_KV.put(key, JSON.stringify(next));
    return sendMessage(env, chatId, `✅ فیلتر «${word}» لغو شد.`);
  }

    // معاف کردن کاربر از فیلتر کلمات
  if (args[1] === "کاربر" && args[2] === "آزاد") {
    if (!target || !target.id) {
      return sendMessage(
        env,
        chatId,
        "❌ این دستور را با Reply روی پیام عضو موردنظر بفرست."
      );
    }

    const key = `filter_exempt:${chatId}`;
    const exemptUsers =
      (await env.SHAHED_KV.get(key, "json")) || [];

    const targetId = String(target.id);

    if (exemptUsers.includes(targetId)) {
      return sendMessage(
        env,
        chatId,
        "ℹ️ این عضو از قبل از فیلتر کلمات معاف است."
      );
    }

    exemptUsers.push(targetId);

    await env.SHAHED_KV.put(
      key,
      JSON.stringify(exemptUsers)
    );

    return sendMessage(
      env,
      chatId,
      "✅ این عضو از فیلتر کلمات معاف شد."
    );
  }

  // بازگرداندن کاربر به وضعیت عادی فیلتر
  if (args[1] === "کاربر" && args[2] === "محدود") {
    if (!target || !target.id) {
      return sendMessage(
        env,
        chatId,
        "❌ این دستور را با Reply روی پیام عضو موردنظر بفرست."
      );
    }

    const key = `filter_exempt:${chatId}`;
    const exemptUsers =
      (await env.SHAHED_KV.get(key, "json")) || [];

    const targetId = String(target.id);

    if (!exemptUsers.includes(targetId)) {
      return sendMessage(
        env,
        chatId,
        "ℹ️ این عضو از قبل در وضعیت عادی فیلتر است."
      );
    }

    const remainingUsers = exemptUsers.filter(
      id => id !== targetId
    );

    if (remainingUsers.length > 0) {
      await env.SHAHED_KV.put(
        key,
        JSON.stringify(remainingUsers)
      );
    } else {
      await env.SHAHED_KV.delete(key);
    }

    return sendMessage(
      env,
      chatId,
      "✅ معافیت این عضو لغو شد و فیلتر کلمات دوباره برای او فعال است."
    );
  }
  if (args[1] === "قفل" && args[2] === "گروه") {
    return lockGroup(msg, env);
  }

  if (args[1] === "راهنما" || args.length === 1) {
    return sendGMHelp(env, chatId);
  }

  if (!target) {
    return sendMessage(env, chatId, "❌ این دستور باید با Reply روی پیام کاربر ارسال شود.");
  }

  const targetId = target.id;
  const action = args[1] || "";
  const value = args[2] ? Number(args[2]) : null;

  switch (action) {
    case "حذف":
      return deleteMessage(env, chatId, targetMessage.message_id);
    case "سکوت":
      if (args[2] && (!Number.isFinite(value) || value <= 0)) {
        return sendMessage(env, chatId, "❌ مدت سکوت باید یک عدد مثبت بر حسب دقیقه باشد.");
      }
      return restrictUser(env, chatId, targetId, value);
    case "لغو":
      if (args[2] === "سکوت") return unrestrictUser(env, chatId, targetId);
      if (args[2] === "اخطار") return removeWarning(env, chatId, targetId);
      break;
    case "بن":
      return banUser(env, chatId, targetId);
    case "اخطار":
      return addWarning(env, chatId, targetId, target);
  }
  return sendGMHelp(env, chatId);
}

async function sendGMHelp(env, chatId) {
  return sendMessage(env, chatId,
`🛠 راهنمای /gm

دستورهای Reply:
 /gm حذف پیام
 /gm سکوت
 /gm سکوت 50
 /gm لغو سکوت
 /gm بن
 /gm اخطار
 /gm لغو اخطار

مدیریت فیلتر:
 /gm تنظیم فیلتر(کلمه)
 /gm لغو فیلتر(کلمه)

کل گروه:
 /gm قفل گروه`);
}

async function lockGroup(msg, env) {
  const permissions = {
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
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false
  };
  const result = await tg(env, "setChatPermissions", {
    chat_id: msg.chat.id,
    permissions: JSON.stringify(permissions),
    use_independent_chat_permissions: true
  });
  if (!result.ok) return sendTelegramError(env, msg.chat.id, result);
  return sendMessage(env, msg.chat.id, "🔒 گروه قفل شد.");
}

async function restrictUser(env, chatId, userId, minutes) {
  const permissions = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  };
  const params = {
    chat_id: chatId,
    user_id: userId,
    permissions: JSON.stringify(permissions),
    use_independent_chat_permissions: true
  };
  if (minutes) params.until_date = Math.floor(Date.now() / 1000) + minutes * 60;
  const result = await tg(env, "restrictChatMember", params);
  if (!result.ok) return sendTelegramError(env, chatId, result);
  return sendMessage(env, chatId, minutes ? `🔇 کاربر برای ${minutes} دقیقه سکوت شد.` : "🔇 کاربر سکوت شد.");
}

async function unrestrictUser(env, chatId, userId) {
  const permissions = {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true
  };
  const result = await tg(env, "restrictChatMember", {
    chat_id: chatId, user_id: userId,
    permissions: JSON.stringify(permissions),
    use_independent_chat_permissions: true
  });
  if (!result.ok) return sendTelegramError(env, chatId, result);
  return sendMessage(env, chatId, "🔊 سکوت کاربر لغو شد.");
}

async function banUser(env, chatId, userId) {
  const result = await tg(env, "banChatMember", {
    chat_id: chatId, user_id: userId, revoke_messages: true
  });
  if (!result.ok) return sendTelegramError(env, chatId, result);
  return sendMessage(env, chatId, "🚫 کاربر از گروه بن شد.");
}

async function addWarning(env, chatId, userId, user, reason = "") {
  const key = `warnings:${chatId}:${userId}`;
  const current = Number(await env.SHAHED_KV.get(key)) || 0;
  const next = current + 1;

  if (next >= 3) {
    await env.SHAHED_KV.delete(key);
    const result = await tg(env, "banChatMember", {
      chat_id: chatId, user_id: userId, revoke_messages: true
    });
    if (!result.ok) return sendTelegramError(env, chatId, result);
    return sendMessage(env, chatId, `⚠️ اخطار سوم ثبت شد؛ کاربر بن شد.${reason ? "\n" + reason : ""}`);
  }

  await env.SHAHED_KV.put(key, String(next));
  const name = escapeHtml(user.first_name || "کاربر");
  return sendMessage(env, chatId, `⚠️ اخطار ${next}/3 برای ${name} ثبت شد.${reason ? "\n" + reason : ""}`);
}

async function removeWarning(env, chatId, userId) {
  const key = `warnings:${chatId}:${userId}`;
  const current = Number(await env.SHAHED_KV.get(key)) || 0;
  if (current <= 0) return sendMessage(env, chatId, "ℹ️ این کاربر اخطاری ندارد.");
  const next = current - 1;
  if (next === 0) await env.SHAHED_KV.delete(key);
  else await env.SHAHED_KV.put(key, String(next));
  return sendMessage(env, chatId, `✅ یک اخطار کم شد. وضعیت فعلی: ${next}/3`);
}

async function buildSavedMessage(msg) {
  if (msg.text) return { type: "text", text: msg.text };
  if (msg.photo?.length) return { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "" };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "" };
  if (msg.audio) return { type: "audio", file_id: msg.audio.file_id, caption: msg.caption || "" };
  if (msg.voice) return { type: "voice", file_id: msg.voice.file_id };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id, caption: msg.caption || "" };
  if (msg.sticker) return { type: "sticker", file_id: msg.sticker.file_id };
  return null;
}

async function sendSavedMessage(env, chatId, saved, replyTo) {
  const common = { chat_id: chatId };
  switch (saved.type) {
    case "text": return sendMessage(env, chatId, saved.text, replyTo);
    case "photo": return tg(env, "sendPhoto", { ...common, photo: saved.file_id, caption: saved.caption || "" });
    case "video": return tg(env, "sendVideo", { ...common, video: saved.file_id, caption: saved.caption || "" });
    case "document": return tg(env, "sendDocument", { ...common, document: saved.file_id, caption: saved.caption || "" });
    case "audio": return tg(env, "sendAudio", { ...common, audio: saved.file_id, caption: saved.caption || "" });
    case "voice": return tg(env, "sendVoice", { ...common, voice: saved.file_id });
    case "animation": return tg(env, "sendAnimation", { ...common, animation: saved.file_id, caption: saved.caption || "" });
    case "sticker": return tg(env, "sendSticker", { ...common, sticker: saved.file_id });
  }
}

async function sendMessage(env, chatId, text, replyTo = null) {
  const params = { chat_id: chatId, text };
  if (replyTo) params.reply_parameters = { message_id: replyTo };
  return tg(env, "sendMessage", params);
}

async function deleteMessage(env, chatId, messageId) {
  const result = await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
  if (!result.ok) return sendTelegramError(env, chatId, result);
}

async function sendTelegramError(env, chatId, result) {
  // Do not write API responses or user-related context to Worker logs.
  return sendMessage(env, chatId, `❌ عملیات انجام نشد.\n${result.description || "خطای ناشناخته Telegram"}`);
}

async function tg(env, method, params = {}) {
  const response = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  return response.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
