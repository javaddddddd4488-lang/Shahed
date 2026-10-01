const TELEGRAM_API = "https://api.telegram.org/bot";

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Shahed Telegram Bot is running.");
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("OK");
    } catch (err) {
      console.error("Webhook error:", err);
      return new Response("OK");
    }
  },
};

async function handleUpdate(update, env) {
  if (!update.message) return;

  const msg = update.message;
  const chat = msg.chat;
  const text = msg.text || "";
  const isPrivate = chat.type === "private";
  const isGroup = ["group", "supergroup"].includes(chat.type);

  // /save فقط برای ادمین و فقط در PV
  if (text.startsWith("/save")) {
    if (!isPrivate) return;

    if (!isAdmin(msg.from?.id, env)) {
      return sendMessage(
        env,
        chat.id,
        "❌ شما اجازه استفاده از /save را ندارید."
      );
    }

    const parts = text.trim().split(/\s+/);

    if (parts.length !== 2 || !parts[1].startsWith("/")) {
      return sendMessage(
        env,
        chat.id,
        "فرمت صحیح:\n/save /test\n\nبعد از آن، پیام موردنظر را در همین چت ارسال کنید."
      );
    }

    const command = normalizeCommand(parts[1]);

    await env.SHAHED_KV.put(
      `pending_save:${msg.from.id}`,
      JSON.stringify({
        command,
        createdAt: Date.now(),
      })
    );

    return sendMessage(
      env,
      chat.id,
      `✅ کامند ${command} آماده ذخیره است.\nحالا پیام موردنظر را در همین PV ارسال کنید.`
    );
  }

  // دریافت پیام بعد از /save
  if (isPrivate && msg.from && isAdmin(msg.from.id, env)) {
    const pending = await env.SHAHED_KV.get(
      `pending_save:${msg.from.id}`,
      "json"
    );

    if (pending) {
      if (text.startsWith("/save")) return;

      const payload = await buildSavedMessage(msg);

      if (!payload) {
        return sendMessage(
          env,
          chat.id,
          "❌ فعلاً ذخیره این نوع پیام پشتیبانی نمی‌شود."
        );
      }

      await env.SHAHED_KV.put(
        `saved:${pending.command}`,
        JSON.stringify(payload)
      );

      await env.SHAHED_KV.delete(
        `pending_save:${msg.from.id}`
      );

      return sendMessage(
        env,
        chat.id,
        `✅ ذخیره شد.\nبرای استفاده:\n${pending.command}`
      );
    }
  }

  // /gm فقط برای ادمین و داخل گروه
  if (isGroup && text.startsWith("/gm")) {
    if (!isAdmin(msg.from?.id, env)) {
      return sendMessage(
        env,
        chat.id,
        "❌ فقط ادمین شاهد می‌تواند از /gm استفاده کند."
      );
    }

    return handleGM(msg, env);
  }

  // کامندهای ذخیره‌شده برای همه
  if (isGroup && text.startsWith("/")) {
    const command = normalizeCommand(
      text.split(/\s+/)[0]
    );

    if (!command || command === "/gm") return;

    const saved = await env.SHAHED_KV.get(
      `saved:${command}`,
      "json"
    );

    if (saved) {
      return sendSavedMessage(
        env,
        chat.id,
        saved,
        msg.message_id
      );
    }
  }
}

function isAdmin(userId, env) {
  if (!userId || !env.ADMIN_IDS) return false;

  return env.ADMIN_IDS
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .includes(String(userId));
}

function normalizeCommand(command) {
  if (!command) return "";

  const clean = command.trim().split("@")[0];

  return clean.startsWith("/")
    ? clean.toLowerCase()
    : "";
}

async function handleGM(msg, env) {
  const chatId = msg.chat.id;
  const args = msg.text.trim().split(/\s+/);

  const action = args[1] || "";
  const value = args[2]
    ? Number(args[2])
    : null;

  const target = msg.reply_to_message?.from;
  const targetMessage = msg.reply_to_message;

  // قفل گروه روی کل گروه اعمال می‌شود
  if (
    action === "قفل" &&
    args[2] === "گروه"
  ) {
    return lockGroup(msg, env);
  }

  // بقیه دستورات باید Reply باشند
  if (!target) {
    return sendMessage(
      env,
      chatId,
      "❌ این دستور باید با Reply روی پیام کاربر ارسال شود."
    );
  }

  const targetId = target.id;

  switch (action) {

    case "حذف":
      return deleteMessage(
        env,
        chatId,
        targetMessage.message_id
      );

    case "سکوت":

      if (
        args[2] &&
        (!Number.isFinite(value) || value <= 0)
      ) {
        return sendMessage(
          env,
          chatId,
          "❌ مدت سکوت باید یک عدد مثبت بر حسب دقیقه باشد."
        );
      }

      return restrictUser(
        env,
        chatId,
        targetId,
        value
      );

    case "لغو":

      if (args[2] === "سکوت") {
        return unrestrictUser(
          env,
          chatId,
          targetId
        );
      }

      if (args[2] === "اخطار") {
        return removeWarning(
          env,
          chatId,
          targetId,
          target
        );
      }

      break;

    case "بن":
      return banUser(
        env,
        chatId,
        targetId
      );

    case "اخطار":
      return addWarning(
        env,
        chatId,
        targetId,
        target
      );

    default:
      return sendGMHelp(
        env,
        chatId
      );
  }
}

async function sendGMHelp(env, chatId) {
  return sendMessage(
    env,
    chatId,
`🛠 راهنمای /gm

دستورها باید روی پیام فرد موردنظر Reply شوند:

/gm حذف پیام
/gm سکوت
/gm سکوت 50
/gm لغو سکوت
/gm بن
/gm اخطار
/gm لغو اخطار

دستور مربوط به کل گروه:

/gm قفل گروه`
  );
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

  const result = await tg(
    env,
    "setChatPermissions",
    {
      chat_id: msg.chat.id,
      permissions: JSON.stringify(permissions),
      use_independent_chat_permissions: true
    }
  );

  if (!result.ok) {
    return sendTelegramError(
      env,
      msg.chat.id,
      result
    );
  }

  return sendMessage(
    env,
    msg.chat.id,
    "🔒 گروه قفل شد."
  );
}

async function restrictUser(
  env,
  chatId,
  userId,
  minutes
) {

  const until = minutes
    ? Math.floor(Date.now() / 1000) +
      minutes * 60
    : 0;

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

  if (minutes) {
    params.until_date = until;
  }

  const result = await tg(
    env,
    "restrictChatMember",
    params
  );

  if (!result.ok) {
    return sendTelegramError(
      env,
      chatId,
      result
    );
  }

  return sendMessage(
    env,
    chatId,
    minutes
      ? `🔇 کاربر برای ${minutes} دقیقه سکوت شد.`
      : "🔇 کاربر سکوت شد."
  );
}

async function unrestrictUser(
  env,
  chatId,
  userId
) {

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

  const result = await tg(
    env,
    "restrictChatMember",
    {
      chat_id: chatId,
      user_id: userId,
      permissions: JSON.stringify(permissions),
      use_independent_chat_permissions: true
    }
  );

  if (!result.ok) {
    return sendTelegramError(
      env,
      chatId,
      result
    );
  }

  return sendMessage(
    env,
    chatId,
    "🔊 سکوت کاربر لغو شد."
  );
}

async function banUser(
  env,
  chatId,
  userId
) {

  const result = await tg(
    env,
    "banChatMember",
    {
      chat_id: chatId,
      user_id: userId,
      revoke_messages: true
    }
  );

  if (!result.ok) {
    return sendTelegramError(
      env,
      chatId,
      result
    );
  }

  return sendMessage(
    env,
    chatId,
    "🚫 کاربر از گروه بن شد."
  );
}

async function addWarning(
  env,
  chatId,
  userId,
  user
) {

  const key =
    `warnings:${chatId}:${userId}`;

  const current =
    Number(
      await env.SHAHED_KV.get(key)
    ) || 0;

  const next = current + 1;

  if (next >= 3) {

    await env.SHAHED_KV.delete(key);

    const result = await tg(
      env,
      "banChatMember",
      {
        chat_id: chatId,
        user_id: userId,
        revoke_messages: true
      }
    );

    if (!result.ok) {
      return sendTelegramError(
        env,
        chatId,
        result
      );
    }

    return sendMessage(
      env,
      chatId,
      "⚠️ اخطار سوم ثبت شد؛ کاربر بن شد."
    );
  }

  await env.SHAHED_KV.put(
    key,
    String(next)
  );

  const name =
    escapeHtml(
      user.first_name || "کاربر"
    );

  return sendMessage(
    env,
    chatId,
    `⚠️ اخطار ${next}/3 برای ${name} ثبت شد.`
  );
}

async function removeWarning(
  env,
  chatId,
  userId,
  user
) {

  const key =
    `warnings:${chatId}:${userId}`;

  const current =
    Number(
      await env.SHAHED_KV.get(key)
    ) || 0;

  if (current <= 0) {
    return sendMessage(
      env,
      chatId,
      "ℹ️ این کاربر اخطاری ندارد."
    );
  }

  const next = current - 1;

  if (next === 0) {
    await env.SHAHED_KV.delete(key);
  } else {
    await env.SHAHED_KV.put(
      key,
      String(next)
    );
  }

  return sendMessage(
    env,
    chatId,
    `✅ یک اخطار کم شد. وضعیت فعلی: ${next}/3`
  );
}

async function buildSavedMessage(msg) {

  if (msg.text) {
    return {
      type: "text",
      text: msg.text
    };
  }

  if (msg.photo?.length) {
    return {
      type: "photo",
      file_id:
        msg.photo[msg.photo.length - 1].file_id,
      caption: msg.caption || ""
    };
  }

  if (msg.video) {
    return {
      type: "video",
      file_id: msg.video.file_id,
      caption: msg.caption || ""
    };
  }

  if (msg.document) {
    return {
      type: "document",
      file_id: msg.document.file_id,
      caption: msg.caption || ""
    };
  }

  if (msg.audio) {
    return {
      type: "audio",
      file_id: msg.audio.file_id,
      caption: msg.caption || ""
    };
  }

  if (msg.voice) {
    return {
      type: "voice",
      file_id: msg.voice.file_id
    };
  }

  if (msg.animation) {
    return {
      type: "animation",
      file_id: msg.animation.file_id,
      caption: msg.caption || ""
    };
  }

  if (msg.sticker) {
    return {
      type: "sticker",
      file_id: msg.sticker.file_id
    };
  }

  return null;
}

async function sendSavedMessage(
  env,
  chatId,
  saved,
  replyTo
) {

  const common = {
    chat_id: chatId
  };

  switch (saved.type) {

    case "text":
      return sendMessage(
        env,
        chatId,
        saved.text,
        replyTo
      );

    case "photo":
      return tg(
        env,
        "sendPhoto",
        {
          ...common,
          photo: saved.file_id,
          caption: saved.caption || ""
        }
      );

    case "video":
      return tg(
        env,
        "sendVideo",
        {
          ...common,
          video: saved.file_id,
          caption: saved.caption || ""
        }
      );

    case "document":
      return tg(
        env,
        "sendDocument",
        {
          ...common,
          document: saved.file_id,
          caption: saved.caption || ""
        }
      );

    case "audio":
      return tg(
        env,
        "sendAudio",
        {
          ...common,
          audio: saved.file_id,
          caption: saved.caption || ""
        }
      );

    case "voice":
      return tg(
        env,
        "sendVoice",
        {
          ...common,
          voice: saved.file_id
        }
      );

    case "animation":
      return tg(
        env,
        "sendAnimation",
        {
          ...common,
          animation: saved.file_id,
          caption: saved.caption || ""
        }
      );

    case "sticker":
      return tg(
        env,
        "sendSticker",
        {
          ...common,
          sticker: saved.file_id
        }
      );
  }
}

async function sendMessage(
  env,
  chatId,
  text,
  replyTo = null
) {

  const params = {
    chat_id: chatId,
    text
  };

  if (replyTo) {
    params.reply_parameters =
      JSON.stringify({
        message_id: replyTo
      });
  }

  return tg(
    env,
    "sendMessage",
    params
  );
}

async function deleteMessage(
  env,
  chatId,
  messageId
) {

  const result = await tg(
    env,
    "deleteMessage",
    {
      chat_id: chatId,
      message_id: messageId
    }
  );

  if (!result.ok) {
    return sendTelegramError(
      env,
      chatId,
      result
    );
  }
}

async function sendTelegramError(
  env,
  chatId,
  result
) {

  console.error(
    "Telegram API error:",
    result
  );

  return sendMessage(
    env,
    chatId,
    `❌ عملیات انجام نشد.\n${
      result.description ||
      "خطای ناشناخته Telegram"
    }`
  );
}

async function tg(
  env,
  method,
  params = {}
) {

  const response = await fetch(
    `${TELEGRAM_API}${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    }
  );

  return response.json();
}

function escapeHtml(s) {

  return String(s).replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c])
  );
  }
