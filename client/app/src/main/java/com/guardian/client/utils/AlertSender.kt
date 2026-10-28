package com.guardian.client.utils

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.guardian.client.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object AlertSender {
    private const val TAG = "AlertSender"

    const val PREFS = "GuardianPrefs"
    const val PREF_KID_NAME = "kid_name"
    const val PREF_LAST_SYNC_OK = "last_sync_ok_at"
    const val PREF_LAST_SEND_OK = "last_send_ok_at"
    const val PREF_LAST_SEND_ERROR = "last_send_error"
    private const val PREF_PENDING = "pending_alerts"
    private const val PREF_CACHED_KEYWORDS = "cached_keywords"
    private const val PREF_LAST_SYNC_ATTEMPT = "last_sync_attempt"

    private const val MAX_PENDING = 50
    private const val SYNC_INTERVAL_MS = 60 * 60 * 1000L
    private const val SYNC_RETRY_MS = 5 * 60 * 1000L
    private const val DUPLICATE_WINDOW_MS = 10 * 60 * 1000L
    private const val FLUSH_MIN_GAP_MS = 60 * 1000L
    private const val MAX_CONTEXT_CHATS = 50

    val SERVER_URL: String get() = BuildConfig.SERVER_URL

    // Render's free tier needs up to ~60s to wake from sleep, so the timeouts must be generous.
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    data class ContextMessage(val sender: String, val text: String)
    data class AlertPayload(
        val kid_name: String,
        val chat_name: String,
        val sender: String,
        val target_text: String,
        val context: List<ContextMessage>
    )
    data class KeywordResponse(val keywords: List<String>?)

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------
    // Rolling per-chat context (last 5 messages)
    // ------------------------------------------------------------------
    private val chatContexts = object : LinkedHashMap<String, MutableList<ContextMessage>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, MutableList<ContextMessage>>?): Boolean {
            return size > MAX_CONTEXT_CHATS
        }
    }

    @Synchronized
    fun addMessageToContext(chatId: String, sender: String, text: String) {
        val list = chatContexts.getOrPut(chatId) { mutableListOf() }
        list.add(ContextMessage(sender, text))
        if (list.size > 5) {
            list.removeAt(0)
        }
    }

    /** Context for a chat, excluding the very last message (which is the target). */
    @Synchronized
    fun getChatContext(chatId: String): List<ContextMessage> {
        val list = chatContexts[chatId] ?: return emptyList()
        return if (list.isNotEmpty()) list.dropLast(1).toList() else emptyList()
    }

    // ------------------------------------------------------------------
    // Keyword matching
    // ------------------------------------------------------------------
    private val invisibleChars = Regex("[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF\\u0591-\\u05C7]")
    private val whitespace = Regex("\\s+")
    private val wordSplit = Regex("[\\s.,!?;:\"'()#@\\-*_+=~`\\[\\]{}|\\\\<>/…׳״]+")
    private const val PREFIX_CHARS = "הובלמשכ"
    private val SUFFIXES = listOf("", "ים", "ות", "ה", "יה", "יית", "אי")

    /** Lower-cases and removes niqqud + invisible bidi marks that WhatsApp inserts in RTL text. */
    fun normalizeForMatch(text: String): String {
        return whitespace.replace(invisibleChars.replace(text, ""), " ").trim().lowercase()
    }

    /** A short keyword matches a whole word, optionally with up to two Hebrew prefix letters and a common suffix. */
    private fun matchesShortKeyword(word: String, kw: String): Boolean {
        var candidate = word
        var stripped = 0
        while (true) {
            for (suffix in SUFFIXES) {
                if (candidate == kw + suffix) return true
            }
            if (stripped >= 2 || candidate.length <= kw.length || candidate[0] !in PREFIX_CHARS) return false
            candidate = candidate.substring(1)
            stripped++
        }
    }

    /**
     * Checks if a message contains any Hebrew threat keyword.
     * Phrases / long keywords use substring matching; short keywords use word matching with light stemming
     * (so "ענית" does not trigger on "עני").
     */
    fun containsThreatKeyword(text: String, keywords: List<String>): Boolean {
        val norm = normalizeForMatch(text)
        if (norm.isEmpty()) return false
        val words = norm.split(wordSplit).filter { it.isNotEmpty() }

        for (keyword in keywords) {
            val kw = normalizeForMatch(keyword)
            if (kw.isEmpty()) continue
            if (kw.length >= 5 || kw.contains(' ')) {
                if (norm.contains(kw)) return true
            } else {
                for (word in words) {
                    if (matchesShortKeyword(word, kw)) return true
                }
            }
        }
        return false
    }

    // ------------------------------------------------------------------
    // Keywords: cached in memory + SharedPreferences, refreshed at most hourly
    // ------------------------------------------------------------------
    private val DEFAULT_KEYWORDS = listOf(
        // Physical violence & Threats
        "מכות", "להרוג", "נדקור", "סכין", "לרצוח", "אשבור לך", "נביא לך",
        "לפוצץ אותך", "ניפגש בחוץ", "נרביץ", "אגרוף", "כאפה", "כאפות", "לכסח",

        // Bullying & Social Exclusion
        "חרם", "מוחרם", "מוחרמת", "אל תדברו איתו", "אל תדברו איתה", "אל תדברו איתם",
        "נעיף אותו", "נעיף אותה", "להעיף אותו", "להעיף אותה", "אל תזמינו אותו", "אל תזמינו אותה",
        "לא משתפים אותו", "לא משתפות אותה", "מנודה", "מנודת", "לא רוצים אותך", "שונאים אותך", "שונאות אותך",
        "מחוץ לקבוצה", "קבוצה בלעדיו", "קבוצה בלעדיה",

        // Cognitive / Disability Shaming
        "מפגר", "מפגרת", "אוטיסט", "אוטיסטית", "נכה", "נכה בראש", "סתומה", "סתום",
        "טיפש", "טיפשה", "חולה נפש", "פיגור",

        // Body Shaming
        "מכוער", "מכוערת", "שמן", "שמנה", "דוב", "דובה", "חזיר", "חזירה", "קוף", "קופה", "אנורקסית",

        // Loser / Poverty Shaming
        "עני", "ענייה", "קמצן", "קמצנית", "לוזר", "לוזרית", "מסכן", "מסכנה", "הומלס", "הומלסית",

        // Death Wishes / Severe Harassment
        "תמות", "תמותי", "תחנק", "תחנקי", "תתאבד", "תתאבדי", "תישרף", "תישרפי",
        "שתקבל סרטן", "שתקבלי סרטן", "עוף מפה", "עופי מפה", "תחפף", "תחפפי",

        // Gender-specific Slurs & Swears
        "הומו", "קוקסינל", "לסבית", "זונה", "שרמוטה", "בן זונה", "בת זונה", "כלבה", "כלב"
    )

    @Volatile
    private var keywordCache: List<String>? = null

    fun getKeywords(context: Context): List<String> {
        keywordCache?.let { return it }
        val json = prefs(context).getString(PREF_CACHED_KEYWORDS, null)
        val parsed: List<String>? = if (json == null) null else try {
            gson.fromJson(json, Array<String>::class.java)?.map { it.trim() }?.filter { it.isNotEmpty() }
        } catch (e: Exception) {
            null
        }
        // Never end up with an empty list: that would silently disable all monitoring.
        val list = if (parsed.isNullOrEmpty()) DEFAULT_KEYWORDS else parsed
        keywordCache = list
        return list
    }

    private fun storeKeywords(context: Context, keywords: List<String>) {
        keywordCache = keywords
        prefs(context).edit()
            .putString(PREF_CACHED_KEYWORDS, gson.toJson(keywords))
            .putLong(PREF_LAST_SYNC_OK, System.currentTimeMillis())
            .apply()
    }

    private fun newRequest(path: String): Request.Builder {
        val builder = Request.Builder().url("$SERVER_URL$path")
        if (BuildConfig.DEVICE_TOKEN.isNotEmpty()) builder.header("X-Device-Token", BuildConfig.DEVICE_TOKEN)
        return builder
    }

    /** Fetches the keyword list from the server. Throttled to once an hour unless [force] is set. */
    fun syncKeywords(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        val p = prefs(app)
        val now = System.currentTimeMillis()
        val haveCache = p.getString(PREF_CACHED_KEYWORDS, null) != null
        if (!force && haveCache && now - p.getLong(PREF_LAST_SYNC_ATTEMPT, 0L) < SYNC_INTERVAL_MS) return
        p.edit().putLong(PREF_LAST_SYNC_ATTEMPT, now).apply()

        scope.launch {
            try {
                client.newCall(newRequest("/api/config/keywords").get().build()).execute().use { response ->
                    if (response.isSuccessful) {
                        val res = gson.fromJson(response.body?.string(), KeywordResponse::class.java)
                        val list = res?.keywords?.map { it.trim() }?.filter { it.isNotEmpty() }
                        if (!list.isNullOrEmpty()) {
                            storeKeywords(app, list)
                            Log.d(TAG, "Keywords synced: ${list.size} words")
                            return@use
                        }
                    }
                    Log.w(TAG, "Keyword sync failed: HTTP ${response.code}")
                    p.edit().putLong(PREF_LAST_SYNC_ATTEMPT, now - SYNC_INTERVAL_MS + SYNC_RETRY_MS).apply()
                }
            } catch (e: Exception) {
                Log.w(TAG, "Network error syncing keywords: ${e.message}")
                p.edit().putLong(PREF_LAST_SYNC_ATTEMPT, now - SYNC_INTERVAL_MS + SYNC_RETRY_MS).apply()
            }
        }
    }

    /** Used by the setup screen's "test connection" button. Callback runs on the main thread. */
    fun testConnection(context: Context, callback: (Boolean, String) -> Unit) {
        val app = context.applicationContext
        scope.launch {
            var ok = false
            val message: String = try {
                client.newCall(newRequest("/api/config/keywords").get().build()).execute().use { response ->
                    when {
                        response.isSuccessful -> {
                            val res = gson.fromJson(response.body?.string(), KeywordResponse::class.java)
                            val list = res?.keywords?.map { it.trim() }?.filter { it.isNotEmpty() }
                            if (!list.isNullOrEmpty()) storeKeywords(app, list)
                            ok = true
                            "החיבור לשרת תקין (${list?.size ?: 0} מילות מפתח)"
                        }
                        response.code == 401 -> "השרת דחה את הטוקן (401) - יש לוודא ש-DEVICE_TOKEN זהה בשרת ובבנייה"
                        else -> "השרת החזיר שגיאה ${response.code}"
                    }
                }
            } catch (e: IOException) {
                "אין חיבור לשרת: ${e.message}"
            }
            withContext(Dispatchers.Main) { callback(ok, message) }
        }
    }

    // ------------------------------------------------------------------
    // Sending: persistent queue + retry with backoff (survives Render cold starts and offline periods)
    // ------------------------------------------------------------------
    private enum class SendResult { OK, RETRY, DROP }

    private val queueLock = Any()
    private val flushing = AtomicBoolean(false)
    @Volatile
    private var lastFlushAttempt = 0L

    private fun loadQueue(context: Context): MutableList<String> {
        val json = prefs(context).getString(PREF_PENDING, null) ?: return mutableListOf()
        return try {
            gson.fromJson(json, Array<String>::class.java)?.toMutableList() ?: mutableListOf()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    private fun saveQueue(context: Context, queue: List<String>) {
        prefs(context).edit().putString(PREF_PENDING, gson.toJson(queue)).apply()
    }

    private fun enqueue(context: Context, payload: String) {
        synchronized(queueLock) {
            val queue = loadQueue(context)
            if (!queue.contains(payload)) {
                queue.add(payload)
                while (queue.size > MAX_PENDING) queue.removeAt(0)
                saveQueue(context, queue)
            }
        }
    }

    private fun peek(context: Context): String? = synchronized(queueLock) { loadQueue(context).firstOrNull() }

    private fun removeFromQueue(context: Context, payload: String) {
        synchronized(queueLock) {
            val queue = loadQueue(context)
            if (queue.remove(payload)) saveQueue(context, queue)
        }
    }

    fun pendingCount(context: Context): Int = synchronized(queueLock) { loadQueue(context).size }

    private fun post(context: Context, payload: String): SendResult {
        val p = prefs(context)
        return try {
            val request = newRequest("/api/alerts").post(payload.toRequestBody(jsonMediaType)).build()
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> {
                        p.edit().putLong(PREF_LAST_SEND_OK, System.currentTimeMillis()).remove(PREF_LAST_SEND_ERROR).apply()
                        SendResult.OK
                    }
                    response.code == 408 || response.code == 429 || response.code == 401 || response.code >= 500 -> {
                        p.edit().putString(PREF_LAST_SEND_ERROR, "HTTP ${response.code}").apply()
                        Log.w(TAG, "Server returned ${response.code}; will retry")
                        SendResult.RETRY
                    }
                    else -> {
                        Log.e(TAG, "Server rejected alert: ${response.code}")
                        SendResult.DROP
                    }
                }
            }
        } catch (e: IOException) {
            p.edit().putString(PREF_LAST_SEND_ERROR, e.message ?: "network error").apply()
            Log.w(TAG, "Network error sending alert: ${e.message}")
            SendResult.RETRY
        }
    }

    /** Sends everything in the queue, backing off between failures. Safe to call often. */
    fun flushPending(context: Context) {
        val app = context.applicationContext
        if (!flushing.compareAndSet(false, true)) return
        lastFlushAttempt = System.currentTimeMillis()
        scope.launch {
            var gaveUp = false
            try {
                var failures = 0
                while (true) {
                    val payload = peek(app) ?: break
                    when (post(app, payload)) {
                        SendResult.OK, SendResult.DROP -> {
                            removeFromQueue(app, payload)
                            failures = 0
                        }
                        SendResult.RETRY -> {
                            failures++
                            if (failures >= 6) {
                                gaveUp = true
                                break
                            }
                            delay(minOf(60_000L, 3_000L * (1L shl failures)))
                        }
                    }
                }
            } finally {
                flushing.set(false)
            }
            // An alert may have been queued just as the loop ended.
            if (!gaveUp && peek(app) != null) flushPending(app)
        }
    }

    /** Cheap hook for services: retry queued alerts if the last attempt was a while ago. */
    fun flushIfDue(context: Context) {
        if (System.currentTimeMillis() - lastFlushAttempt < FLUSH_MIN_GAP_MS) return
        if (peek(context.applicationContext) != null) flushPending(context)
    }

    // Guards against the screen reader and the notification listener reporting the same message twice.
    private val recentSent = LinkedHashMap<String, Long>()

    @Synchronized
    private fun isRecentDuplicate(text: String): Boolean {
        val norm = text.filter { it.isLetterOrDigit() }.lowercase()
        if (norm.isEmpty()) return false
        val now = System.currentTimeMillis()
        val iter = recentSent.entries.iterator()
        while (iter.hasNext()) {
            if (now - iter.next().value > DUPLICATE_WINDOW_MS) iter.remove()
        }
        for (existing in recentSent.keys) {
            val shorter = minOf(existing.length, norm.length)
            val longer = maxOf(existing.length, norm.length)
            if (existing == norm || (shorter >= 3 && shorter >= longer * 0.4 && (existing.contains(norm) || norm.contains(existing)))) {
                return true
            }
        }
        recentSent[norm] = now
        return false
    }

    /** Queues the flagged message (with context) and sends it to the backend. */
    fun sendAlert(context: Context, chatName: String, sender: String, targetText: String, chatContext: List<ContextMessage>) {
        val app = context.applicationContext
        if (isRecentDuplicate(targetText)) return
        val kidName = prefs(app).getString(PREF_KID_NAME, "שומר") ?: "שומר"
        val payload = gson.toJson(AlertPayload(kidName, chatName, sender, targetText, chatContext))
        enqueue(app, payload)
        flushPending(app)
    }
}
