# WhatsApp Guardian (שומר הוואטסאפ) - Complete Project Architecture & System Summary

> **Comprehensive transfer document for AI systems (Claude / Gemini / GPT) and engineering review.**  
> Contains complete architectural blueprints, codebase layout, Hebrew NLP pipelines, Android accessibility heuristics, backend services, cloud infrastructure, and Git repository evolution.

---

## 1. Executive Summary & Problem Space

**WhatsApp Guardian (שומר הוואטסאפ)** is a dual-tier child protection platform designed to identify and alert parents about **cyberbullying, social exclusion/boycotts (חרם), physical violence threats, hate speech, body shaming, and self-harm** in Hebrew WhatsApp communications.

### Core Philosophy & Operational Model
- **Target Audience:** Pre-teens and teenagers (ages ~9–14) communicating in Hebrew slang, group chats, and direct messages.
- **Privacy-Preserving Edge Architecture:** Rather than transmitting all private conversations to the cloud, the child's Android phone runs a lightweight, low-power edge scanner. Only messages triggering potential threat keywords (plus a rolling 5-message context window) are dispatched to the cloud backend.
- **Deep LLM Semantic Analysis:** Flagged messages are analyzed in the cloud using **Google Gemini 2.5 Flash** with structured output schemas to distinguish between genuine abuse and innocent youth slang (e.g., gaming trash-talk like Minecraft or Fortnite).
- **Human-in-the-Loop Active Learning:** The parent dashboard allows parents to dismiss false positives, which are fed into a Firestore collection and automatically injected as few-shot negative examples into future Gemini prompt contexts.

---

## 2. Git & Version Control

- **Repository Remote:** `https://github.com/PiniMatz/WhatsAppGuardian.git`
- **Default Branch:** `main` (active and clean working tree)
- **Key Milestones in Commit History:**
  1. `e36a877`: Initial scaffolding of Android client (Accessibility Service) and Node.js Express backend.
  2. `2751558` & `0eaefb5`: Deep expansion of Hebrew keyword dictionaries covering gender-specific abuse, cyberbullying, physical threats, and exclusion terminology tailored for elementary/middle schoolers.
  3. `2a534eb`: Migration to Gemini Structured Outputs (`responseSchema`) for strictly typed JSON responses.
  4. `c27a2f9`: Implementation of false-positive dismissal pipeline with prompt-based machine learning.
  5. `ca1c940` to `50dc159`: Experiments with Vercel serverless deployment (`whatsappguard.vercel.app`).
  6. `6dfb110` & `e806562`: Reversion to persistent Express server architecture and deployment to **Render** (`https://whatsappguardian.onrender.com`).
  7. `df05c77` & `3103b93`: Two-tier deduplication engine (Android client SharedPreferences LRU + Server-side in-flight locks and evolving context merging).
  8. `b6d0305` & `33eb7af`: Addition of bulk actions (save/delete/purge unsaved) and dedicated responsive mobile tabs.
  9. `c74d1a8` & `1cdce57`: Heuristic sender resolution for Hebrew RTL layouts using bounding box horizontal overlap checking and grandparent container traversal.
  10. `2526804`: Codebase simplification ("Ponytail") removing redundant permissions, consolidating keyword sources, and streamlining dashboard routing.

---

## 3. Infrastructure & Deployment Architecture

```
                    ┌────────────────────────────────────────┐
                    │      Child's Android Smartphone        │
                    │                                        │
                    │  [ WhatsApp Accessibility Service ]    │
                    │  [ Notification Listener Service  ]    │
                    │                   │                    │
                    │       Heuristic Hebrew Filter          │
                    │  (Prefix / Suffix Stemming Engine)     │
                    │                   │ (Only Flagged)     │
                    └───────────────────┼────────────────────┘
                                        │ HTTPS POST /api/alerts
                                        ▼
                    ┌────────────────────────────────────────┐
                    │       Production Backend (Render)      │
                    │   https://whatsappguardian.onrender.com │
                    │                                        │
                    │  - Node.js (v18+) / Express.js         │
                    │  - In-Flight Request Lock & Dedup      │
                    │  - Substring & Niqqud Text Normalizer  │
                    │                   │                    │
                    │          Hebrew Analysis               │
                    └──────────────┬─────────┬───────────────┘
                                   │         │
                 Structured Prompt │         │ Query False Positives
                     + Context     │         │ & Store Alerts
                                   ▼         ▼
             ┌─────────────────────────┐  ┌─────────────────────────┐
             │    Google Gemini API    │  │    Google Cloud         │
             │   (@google/genai SDK)   │  │   Firebase Firestore    │
             │     gemini-2.5-flash    │  │                         │
             │   responseSchema JSON   │  │  - alerts               │
             └─────────────────────────┘  │  - config/keywords      │
                                          │  - false_positives      │
                                          └──────────┬──────────────┘
                                                     │
                                                     ▼
                                          ┌─────────────────────────┐
                                          │ Parent Web Dashboard    │
                                          │ (RTL Hebrew Glassmorphic│
                                          │   SPA on Express Static)│
                                          └─────────────────────────┘
```

### Hosting & Cloud Components
1. **Production Backend:** Hosted on **Render** as a web service (`https://whatsappguardian.onrender.com`).
2. **Database:** **Google Firebase Firestore** (Google Cloud Project).
   - If `FIREBASE_SERVICE_ACCOUNT` or `firebase-service-account.json` is missing, the server automatically degrades gracefully to an in-memory mock database for local development and offline testing.
3. **AI / LLM Service:** **Google Gemini API** (`gemini-2.5-flash`) via the modern `@google/genai` (v2.10.0) SDK.
4. **Local Development Networking:**
   - Android Emulator: Uses `http://10.0.2.2:3000`.
   - Physical Devices: Tested via local LAN IP or configured directly with the production Render URL.
   - `android:usesCleartextTraffic="true"` enabled in AndroidManifest for seamless local debugging.

### Environment Variables
| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API Key used for semantic message analysis. |
| `FIREBASE_SERVICE_ACCOUNT` | Raw JSON string containing Firebase Service Account credentials (used on Render/Cloud). |
| `PORT` | Web server port (defaults to `3000`). |
| `DASHBOARD_PASSWORD`, `DEVICE_TOKEN`, `TELEGRAM_*`, `GEMINI_MODEL`, `RETENTION_DAYS`, `DEDUP_WINDOW_HOURS` | See section 10 and `docs/SETUP_AND_BUILD.md`. |

---

## 4. Android Client Architecture (`/client`)

### Tech Stack & Dependencies
- **Language:** Kotlin
- **Build System:** Gradle (compileSdk 34, minSdk 26, targetSdk 34, Java 1.8 compatibility)
- **Key Libraries:**
  - `androidx.core:core-ktx:1.12.0`
  - `androidx.appcompat:appcompat:1.6.1`
  - `com.squareup.okhttp3:okhttp:4.12.0` (HTTP dispatch)
  - `com.google.code.gson:gson:2.10.1` (JSON serialization)
  - `org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3` (Background async I/O)

### File Structure & Components
```
client/app/src/main/
├── AndroidManifest.xml
├── java/com/guardian/client/
│   ├── MainActivity.kt
│   ├── services/
│   │   ├── WhatsAppAccessibilityService.kt
│   │   └── WhatsAppNotificationListener.kt
│   └── utils/
│       └── AlertSender.kt
└── res/
    ├── layout/activity_main.xml
    └── xml/accessibility_service_config.xml
```

### Core Subsystems

#### 1. Setup & Status Management (`MainActivity.kt`)
- Allows the parent/child to assign and save the child's identifier (stored in `SharedPreferences` as `kid_name`).
- Provides deep-link buttons directly into Android OS Settings for:
  - Accessibility Service (`Settings.ACTION_ACCESSIBILITY_SETTINGS`)
  - Notification Access (`android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`)
- Real-time diagnostic banner verifying whether both permissions are active. Handles Android 13+ "Restricted Settings" guidance.

#### 2. Screen Scraper & Event Engine (`WhatsAppAccessibilityService.kt`)
Configured via `accessibility_service_config.xml` to exclusively hook `com.whatsapp`:
- **Event Listeners:** `typeWindowStateChanged`, `typeWindowContentChanged`, `typeViewScrolled`.
- **Dynamic Title Detection:** Reads `com.whatsapp:id/conversation_contact_name` or falls back to toolbar coordinate heuristics (Y-coordinate 50–200, X > 100) to ascertain the active chat/group title.
- **RTL Hebrew Sender Extraction Heuristic:**
  - In WhatsApp group chats, sender names are nested TextView elements located above message texts.
  - The service checks the parent container and grandparent siblings.
  - Compares the screen coordinates: child name node must have `childBounds.top < targetBounds.top` and overlapping horizontal bounds (`childBounds.left < targetBounds.right && childBounds.right > targetBounds.left`), ensuring accuracy regardless of LTR/RTL layouts.
  - In 1-on-1 chats, deduces sender based on screen horizontal boundary: incoming messages vs child's messages (`bounds.left < 250`).
- **Comprehensive Noise Filter (`isMetadataOrTime`)**:
  Filters out non-message text nodes:
  - Timestamps (e.g., `11:34`, `11:34 AM`, `23:59`).
  - Standalone phone numbers (`+972...`, `050-...`).
  - Contact tilde indicators (`Nadav ~`).
  - Hebrew date headers and floating dates (`היום`, `אתמול`, `שלשום`, `8 ביולי`).
  - Security and encryption notices (`מוצפן מקצה לקצה`).
  - Unread message counters (`2 הודעות שלא נקראו`).
  - Typing and status indicators (`מחובר/ת`, `הקלידו...`, `online`).
  - WhatsApp overlay pills (`הוספת תג החבר שלך`, `הודעות זמניות`).

#### 3. Push Notification Interceptor (`WhatsAppNotificationListener.kt`)
- Hooks incoming Android notifications from package `com.whatsapp`.
- Catches threats arriving while the device is locked, WhatsApp is minimized, or another app is running.
- Filters out background checks (`Checking for new messages`).
- Appends notification text into `AlertSender` rolling context and triggers threat checks.

#### 4. Threat Matching & Network Dispatch (`AlertSender.kt`)
- **Rolling Context Buffer:** Maintains an in-memory buffer of the last 5 messages per active chat conversation (`chatContexts` map). When an alert is sent, the preceding context lines are dispatched alongside the target text.
- **Smart Hebrew Stemming Filter (`containsThreatKeyword`)**:
  - Handles multi-word phrases by substring.
  - For short words (e.g., `עני`, `נכה`, `זונה`), tokenizes input by punctuation and applies Hebrew prefix stripping (`ה, ו, ב, ל, מ, ש, כ`) and common suffix checks (`ים, ות, ה, יה, יית`).
  - Avoids false alarms on non-threat words with similar roots (e.g., distinguishing "ענית" [you answered] from "עני" [poor/slur]).
- **Remote Keyword Synchronization (`syncKeywords`)**:
  - Periodically fetches the active keyword dictionary from `GET /api/config/keywords`.
  - Caches the JSON array into `SharedPreferences ("cached_keywords")`.
  - Falls back to a rich built-in hardcoded dictionary if offline.
- **Client-Side Deduplication:**
  - Maintains a persistent `LinkedHashSet<String>` of processed message hashes in `SharedPreferences` capped at 100 entries.

---

## 5. Backend Server Architecture (`/server`)

### Tech Stack & Dependencies
- **Runtime:** Node.js (CommonJS modules)
- **Framework:** Express.js 4.19.2
- **Database Driver:** `firebase-admin` 12.1.1
- **LLM SDK:** `@google/genai` 2.10.0
- **Dev Tools:** `dotenv`, `nodemon`

### File Structure
```
server/
├── .env.example
├── firebase-service-account.json (Optional, local dev)
├── package.json
├── server.js               # Main Express app, REST APIs & dedup logic
├── hebrew_analysis.js      # Gemini LLM prompt orchestration
└── public/
    └── index.html          # RTL Hebrew parent dashboard SPA
```

### REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/alerts` | Ingests a flagged message. Performs deduplication, normalizes text, executes Gemini analysis, updates or creates Firestore doc. |
| `GET` | `/api/alerts` | Returns the 50 most recent alerts ordered by timestamp descending. |
| `DELETE` | `/api/alerts/:id` | Deletes a specific alert. |
| `POST` | `/api/alerts/:id/dismiss` | Dismisses an alert as a false positive; persists to `false_positives` collection for few-shot prompt training, then deletes from active alerts. |
| `POST` | `/api/alerts/:id/unsave` | Unstars/unbookmarks an alert. |
| `POST` | `/api/alerts/bulk-save` | Stars/saves multiple alert IDs in a single batch. |
| `POST` | `/api/alerts/bulk-delete` | Deletes multiple alert IDs in a single batch. |
| `POST` | `/api/alerts/delete-unsaved` | Purges all alerts where `saved !== true`. |
| `POST` | `/api/kids/delete` | Deletes all alerts associated with a specific child's name. |
| `GET` | `/api/config/keywords` | Fetches active threat keywords from Firestore or fallback. |
| `POST` | `/api/config/keywords` | Updates the active threat keyword list. |
| `POST` | `/api/config/keywords/reset` | Resets keywords to standard default dictionary. |

### Smart Ingestion & Deduplication Pipeline (`server.js`)
1. **In-Flight Lock Registry (`activeRequests` Set):**
   - Combines `kid_name` + normalized target text prefix as a lock key.
   - Prevents millisecond-level race condition duplicates caused by simultaneous accessibility scroll events.
   - Auto-releases locks after 5 seconds.
2. **Text Normalization Engine (`normalizeText` & `isDuplicateText`)**:
   - Strips Unicode emojis and symbols.
   - Strips Hebrew niqqud (diacritics/vowels: `\u0591-\u05C7`).
   - Retains only alphanumeric Hebrew/English characters and digits.
   - Employs a 60% bidirectional length substring ratio to detect evolving or scrolled message texts.
3. **Evolving Context Updating:**
   - If an incoming alert matches a recently received alert for that child, the backend checks if the context expanded or the text grew.
   - If changed, it updates the existing Firestore record and re-runs the Gemini analysis without generating a redundant UI card.
   - If unchanged, it silently extends the timestamp.

### AI Semantic Analysis Engine (`hebrew_analysis.js`)
- Model: `gemini-2.5-flash`
- **Continuous Prompt-Based Learning:** Before generating content, fetches the 5 most recent entries from `false_positives` in Firestore and injects them as negative examples into the system prompt.
- **Enforced JSON Output:** Uses `responseSchema` to guarantee strict parsing:
  ```json
  {
    "is_threat": true,
    "category": "physical_violence | cyberbullying | self_harm | none",
    "confidence": 0.95,
    "explanation_hebrew": "הסבר מנומק בעברית"
  }
  ```
- **Context Awareness:** Injects the preceding 5 messages with sender tags into the prompt to disambiguate sarcasm, jokes, or defensive replies.

---

## 6. Parent Web Dashboard (`server/public/index.html`)

A complete, zero-dependency, single-file Single Page Application served directly by Express static middleware.

### Visual Design & UI System
- **Language / Direction:** Hebrew (`dir="rtl"`) with `Assistant` and `Outfit` typography.
- **Theme:** Dark mode glassmorphism (`--bg-dark: #0f172a`, card backgrounds `rgba(30, 41, 59, 0.7)` with subtle borders and radial gradient accents).
- **Fully Responsive:** Optimized for both desktop monitors and mobile smartphone browsers.

### Dashboard Panels & Features
1. **Tab 1: התרעות (Alerts Feed)**
   - **Metrics Row:** Real-time counters for total flagged alerts, number of monitored children, and primary danger category.
   - **Child Filter Chips:** Filter feed by child name (`all` or specific child) with a one-click button to purge a child from monitoring.
   - **Bulk Management Bar:** Select all, bulk star/save, bulk delete, or one-click "מחק את כל ההתרעות הלא-שמורות" (delete all unsaved).
   - **Alert Cards:**
     - Header: Child name tag, chat/group title, timestamp.
     - Severity badge: Red (`physical_violence`), Amber (`cyberbullying`), Purple (`self_harm`), Gray (`none`).
     - Confidence meter badge.
     - Main flagged text block.
     - Hebrew AI explanation box with lightbulb icon.
     - Context button: Opens a modal rendering a simulated WhatsApp chat timeline with incoming/outgoing bubbles.
     - Actions: Star/Bookmark, Delete, "התרעת שווא" (Dismiss as false positive to train AI).
2. **Tab 2: שמורות (Saved / Starred Alerts)**
   - Dedicated archive for significant alerts that parents wish to preserve indefinitely.
   - Protected from bulk-deletion routines.
3. **Tab 3: מילים (Keyword Configuration)**
   - Categorized view of the active keyword dictionary:
     - אלימות פיזית ואיומים (Physical violence & threats)
     - חרם ונידוי חברתי (Bullying & social exclusion)
     - שיימינג קוגניטיבי / מוגבלות (Cognitive & disability shaming)
     - שיימינג מראה גופני (Body shaming)
     - קללות מגדריות (Gender slurs & harassment)
     - משאלות מוות (Death wishes & severe harassment)
   - Add new keywords or remove existing ones.
   - "אפס לברירת מחדל" button to restore factory-tested keywords.

---

## 7. Data Flow: End-to-End Walkthrough

```
1. Child receives WhatsApp message in a group: "את לא משתתפת איתנו יותר תעופי מפה"
   │
2. WhatsAppAccessibilityService hooks UI change:
   ├── Verifies package is com.whatsapp
   ├── Extracts chat name ("כיתה ו'2")
   ├── Resolves sender via RTL bounding box overlap ("שירה")
   └── Checks text against local keyword cache ("תעופי מפה", "לא משתתפת") -> MATCH!
   │
3. AlertSender captures preceding 5 messages from rolling memory buffer.
   │
4. HTTP POST dispatched to https://whatsappguardian.onrender.com/api/alerts:
   {
     "kid_name": "נועם",
     "chat_name": "כיתה ו'2",
     "sender": "שירה",
     "target_text": "את לא משתתפת איתנו יותר תעופי מפה",
     "context": [
       {"sender": "דני", "text": "מי בא לכדורגל?"},
       {"sender": "נועם", "text": "אני רוצה"}
     ]
   }
   │
5. Server pipeline:
   ├── Checks in-flight lock (no concurrent duplicates)
   ├── Queries Firestore for recent matching alerts (deduplication check)
   ├── Loads recent 5 false positives from db to build dynamic few-shot prompt
   ├── Calls Gemini 2.5 Flash API with Structured JSON Schema
   │     -> Category: "cyberbullying", is_threat: true, confidence: 0.96
   ├── Writes enriched alert to Firestore collection 'alerts'
   └── Responds 200 OK
   │
6. Parent opens Dashboard:
   ├── Alert card appears under "נועם"
   ├── Shows red/amber alert card with category "חרם ונידוי חברתי / בריונות"
   ├── Displays Gemini explanation: "הודעה זו מצביעה על נידוי וחרם חברתי בוטה"
   └── Parent can click "הצג הקשר שיחה" to inspect the surrounding messages.
```

---

## 8. Development, Installation & Verification Guide

### Backend Setup
1. Prerequisites: Node.js 18+, npm.
2. Navigate to `/server`:
   ```bash
   cd server
   npm install
   ```
3. Create `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...
   PORT=3000
   ```
4. Optional: Place `firebase-service-account.json` in `/server` (if omitted, server runs in mock DB mode).
5. Start server:
   ```bash
   npm start
   # or for auto-reload:
   npm run dev
   ```
6. Open browser at `http://localhost:3000`.

### Android Client Setup
1. Open `/client` in **Android Studio Hedgehog / Iguana / Jellyfish** or later.
2. Verify / adjust backend URL in `client/app/src/main/java/com/guardian/client/utils/AlertSender.kt`:
   - Production: `https://whatsappguardian.onrender.com`
   - Emulator: `http://10.0.2.2:3000`
   - Real Device on LAN: `http://<YOUR_LOCAL_IP>:3000`
3. Build and install on test phone / emulator:
   ```bash
   ./gradlew assembleDebug
   ```
4. Launch app on device:
   - Enter child's name and tap "שמור שם".
   - Enable **Accessibility Service** ("שומר הוואטסאפ"). On Android 13+, if grayed out, enable via: Settings -> Apps -> WhatsApp Guardian -> Top 3 dots -> "Allow restricted settings".
   - Enable **Notification Access**.

---

## 9. Key Technical Inventions & Solutions in the Codebase

1. **Hebrew RTL Dynamic Sender Deduction:**
   Standard accessibility scrapers fail in RTL WhatsApp groups because names and text are placed dynamically. The solution inspects vertical elevation combined with horizontal bounding overlap, supporting both 1-on-1 and multi-nested group layouts.
2. **False-Positive Active Learning without Model Fine-Tuning:**
   When a parent clicks "התרעת שווא", the text and its context are archived into Firestore. Future Gemini evaluations automatically incorporate these real-world corrections as few-shot negative constraints directly into the prompt.
3. **Resilient Dual-Tier Deduplication:**
   Prevents alert storms triggered by user scrolling or continuous typing by combining an in-memory lock on the client, an in-flight server lock set, and Firestore sliding-window context merging.
4. **Zero-Configuration Fallback:**
   The entire backend functions out-of-the-box in mock mode even without Firebase credentials, allowing immediate onboarding for testing and continuous integration environments.

---

## 10. Changes in v1.1 (this review)

- **Server auth:** dashboard + API protected by HTTP Basic (`DASHBOARD_PASSWORD`); the phone uses `X-Device-Token` (`DEVICE_TOKEN`) for `POST /api/alerts` and `GET /api/config/keywords`. Rate limiting, input validation, security headers, no message text in logs.
- **Quota-friendly storage:** in-memory write-through alert cache; `GET /api/alerts?v=<version>` returns `{unchanged:true}` without touching Firestore. Dashboard polls every 15 s only while visible.
- **Telegram alerts** (`TELEGRAM_*` env vars), `/health`, `/api/status`, `/api/test-notification`.
- **Gemini:** configurable/fallback model list (`gemini-3.5-flash` -> `gemini-2.5-flash`; 2.5 is scheduled for shutdown), safety filters relaxed for classification, untrusted text fenced in the prompt, per-child false-positive examples (cached 5 min), failures stored as `analysis_failed` and retried every 5 min.
- **Dashboard:** all dynamic text HTML-escaped (stored XSS fixed), status footer.
- **Android:** persistent send queue with retry/backoff and 2-minute timeouts (Render cold start), device token header, keyword cache in memory + hourly throttled sync with safe fallback, debounced screen scan, hashed/expiring processed-message history, scaled sender detection, noise filter no longer drops short real messages (e.g. names that are months), WhatsApp Business support, notification de-duplication and sender parsing, HTTPS-only + backup disabled, battery-optimisation + connection-test buttons, version/diagnostics on the setup screen.
- **Build:** GitHub Actions builds a signed release APK `WhatsAppGuardian-v1.1.<N>.apk` and publishes it as a Release. See `docs/SETUP_AND_BUILD.md`.
- Default keyword list now lives in `server/default_keywords.js`; the client keeps its own copy as an offline fallback.
