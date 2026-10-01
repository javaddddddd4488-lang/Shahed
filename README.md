# شاهد — Shahed Telegram Bot

بات مدیریتی تلگرام بر پایه Cloudflare Workers + Cloudflare KV.

## قابلیت‌ها

### مدیریت گروه با `/gm`

دستورهای مدیریتی باید روی پیام کاربر موردنظر Reply شوند:

- `/gm حذف پیام`
- `/gm سکوت`
- `/gm سکوت 50`
- `/gm لغو سکوت`
- `/gm بن`
- `/gm اخطار`
- `/gm لغو اخطار`
- `/gm قفل گروه`

هر کاربر حداکثر ۳ اخطار دارد؛ اخطار سوم باعث بن شدن او می‌شود.

`/gm قفل گروه` روی کل گروه اعمال می‌شود و نیاز به Reply ندارد.

### ذخیره پیام با `/save`

در PV بات، فقط ادمین:

```text
/save /test
```

سپس پیام موردنظر را در همان PV می‌فرستد.

از آن به بعد همه کاربران می‌توانند در گروه:

```text
/test
```

را بفرستند و بات پیام ذخیره‌شده را ارسال می‌کند.

فعلاً ذخیره متن، عکس، ویدئو، فایل، صدا، ویس، انیمیشن و استیکر پشتیبانی می‌شود.

## امنیت و Privacy Mode

بات برای گروه با Privacy Mode طراحی شده است و نباید برای دیدن همه پیام‌های گروه تنظیم شود.

بات باید در گروه Administrator باشد و حداقل مجوزهای لازم را داشته باشد:

- Delete messages
- Ban users
- Restrict members
- Manage chat permissions

## Cloudflare KV

یک KV Namespace بسازید و ID آن را در `wrangler.toml` قرار دهید.

KV برای این موارد استفاده می‌شود:

- پیام‌های `/save`
- تعداد اخطارهای هر کاربر
- وضعیت موقت ذخیره‌سازی `/save`

## تنظیم ADMIN_IDS

در Cloudflare Worker Variables یا `wrangler.toml`:

```text
ADMIN_IDS=123456789
```

برای چند ادمین:

```text
ADMIN_IDS=123456789,987654321
```

توصیه می‌شود مقدار واقعی `ADMIN_IDS` را در داشبورد Cloudflare به‌صورت Secret/Variable تنظیم کنید و داخل GitHub قرار ندهید.

## BOT_TOKEN

توکن BotFather را داخل GitHub قرار ندهید.

در Cloudflare:

```text
Settings → Variables and Secrets
```

یک Secret با نام:

```text
BOT_TOKEN
```

بسازید.

## Deploy

پس از ساخت Worker و KV:

```bash
npx wrangler deploy
```

سپس Webhook را روی آدرس Worker تنظیم کنید:

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev
```

برای بررسی:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

## BotFather

Privacy Mode را روشن نگه دارید:

```text
BotFather
→ /mybots
→ Bot
→ Bot Settings
→ Group Privacy
→ Turn on
```

سپس بات را در گروه Administrator کنید.

## نکته درباره `/gm قفل گروه`

این دستور مجوزهای پیش‌فرض ارسال پیام اعضای عادی را می‌بندد. اگر بعداً دستور «لغو قفل گروه» لازم باشد، می‌توان آن را به‌عنوان یک دستور جداگانه اضافه کرد تا مجوزهای معمول گروه دوباره فعال شوند.

## ساختار

```text
shahed-bot/
├── src/
│   └── index.js
├── wrangler.toml
├── README.md
└── .gitignore
```
