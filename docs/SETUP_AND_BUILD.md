# WhatsApp Guardian – setup, build and release (v1.1)

## 1. One-time setup

### 1.1 Render (server)
Environment variables (full list in `server/.env.example`):

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini key (required) |
| `GEMINI_MODEL` | Optional. Default tries `gemini-3.5-flash`, then `gemini-2.5-flash` |
| `FIREBASE_SERVICE_ACCOUNT` | Firestore credentials (JSON string) |
| `DASHBOARD_PASSWORD` | Password the browser asks for when opening the dashboard (any username) |
| `DEVICE_TOKEN` | Secret the phone app sends in `X-Device-Token`. **Must equal the GitHub secret `DEVICE_TOKEN`** |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram alerts. Create a bot with @BotFather, send it a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your chat id |
| `TELEGRAM_INCLUDE_TEXT` | `false` = send names/category only, not the message text |
| `NOTIFY_MIN_CONFIDENCE` | Default `0.5` |
| `PUBLIC_URL` | Dashboard URL added to Telegram messages |
| `RETENTION_DAYS` | Auto-delete *unsaved* alerts older than N days (`0` = keep forever) |
| `DEDUP_WINDOW_HOURS` | Same text from the same child within N hours = same alert (default 24) |

If `DASHBOARD_PASSWORD` / `DEVICE_TOKEN` are not set the server stays open and prints a warning (so a deploy never locks you out by surprise). **Set both.**
After deploying, open the dashboard: the footer shows database, AI model, Telegram and security status, plus a "send test message" button.

### 1.2 Keep Render awake (free plan)
Render's free web service sleeps after ~15 minutes without traffic and needs up to a minute to wake. The app now waits up to 2 minutes and retries from a queue, so alerts are no longer lost, but they can be late. To avoid the delay add a free monitor (e.g. UptimeRobot) that requests `https://<your-service>.onrender.com/health` every 5–10 minutes. A single free service (~744 h/month) fits within Render's 750 free hours.

### 1.3 GitHub secrets (for the APK build)
`release-secrets/GITHUB_AND_RENDER_SECRETS.txt` (local only, git-ignored) lists every value to paste into **Settings → Secrets and variables → Actions**:
`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`, `DEVICE_TOKEN`. Optional variable: `SERVER_URL`.
Back up `release-secrets/guardian-release.jks`. Every APK must be signed with this same key, otherwise Android refuses to install it over the previous one.

## 2. Building the APK
The workflow lives in `.github/workflows/build-apk.yml`.

Push to `main` (any change under `client/`) or run **Actions → Build Android APK → Run workflow**.
The build produces `WhatsAppGuardian-v1.1.<N>.apk` (N = build number, always increasing), attached to the run (Artifacts) and published under **Releases**. The version is also shown inside the app.

Local build (optional, needs the Android SDK): `cd client && gradlew.bat assembleDebug` – uses version `1.1.2` and the debug key unless `VERSION_CODE`, `DEVICE_TOKEN`, `SERVER_URL` and the `KEYSTORE_*` variables are set.

## 3. Installing on the child's phone
1. First time after switching to the CI-built APK: **uninstall the old app** (it was signed with a different key), install the new APK, enter the child's name, re-enable *Accessibility* and *Notification access* (see "Allow restricted settings" in the app).
2. Tap **"מנע עצירת השירות"** and exclude the app from battery optimisation (otherwise Samsung/Xiaomi phones stop the service).
3. Tap **"בדיקת חיבור לשרת"** – it checks the server address and the token.
4. Later updates install over the existing app; permissions are kept.

## 4. Notes
* The app only talks HTTPS (plain HTTP is allowed solely for the emulator address `10.0.2.2` / `localhost`). For a LAN test server add its IP to `res/xml/network_security_config.xml`.
* `DEVICE_TOKEN` is compiled into the APK. It stops random internet users, but anyone who gets hold of the APK file can extract it. Do not share the APK publicly.
* Gemini model names change; if analysis fails the dashboard footer shows the last error and alerts are stored as "analysis failed" and retried every 5 minutes.
