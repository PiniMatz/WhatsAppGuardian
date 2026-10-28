package com.guardian.client.services

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.guardian.client.utils.AlertSender
import java.security.MessageDigest

class WhatsAppAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "WhatsAppAccessibility"
        private val WHATSAPP_PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")
        private const val DEFAULT_CHAT_TITLE = "וואטסאפ"

        // Coalesce bursts of accessibility events into a single screen scan (big battery saver).
        private const val SCAN_DELAY_MS = 350L

        // A message already reported is not reported again for this long (covers scrolling back and forth).
        private const val KEY_TTL_MS = 24L * 60 * 60 * 1000
        private const val MAX_HISTORY_SIZE = 300
        private const val SAVE_DELAY_MS = 5_000L
        private const val PREF_PROCESSED = "processed_keys_v2"
        private const val PREF_PROCESSED_LEGACY = "processed_keys"

        private val TIME_REGEX = Regex("^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](\\s?(AM|PM|am|pm))?$")
        private val PHONE_REGEX = Regex("^\\+?[0-9\\s\\-()]{7,20}$")
        private val DATE_REGEX = Regex("^\\d{1,2}[./\\- ]\\d{1,2}[./\\- ]\\d{2,4}(.*)?$")
        private val DAY_WORD_REGEX = Regex("^(היום|אתמול|שלשום|today|yesterday)[\\p{P}\\p{S}\\s]*$", RegexOption.IGNORE_CASE)

        private val IGNORED_EXACT = setOf(
            "אתמול", "היום", "שלשום", "נמסר", "נקרא", "נשלח", "הודעה זו נמחקה",
            "הודעה נמחקה", "הוספת", "הסרת", "עזב/ה", "הצטרף/ה", "מידע נוסף",
            "למידע נוסף", "הקוד המאובטח", "מחובר/ת", "מחובר", "typing..."
        )

        private val HEBREW_MONTHS = listOf(
            "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
            "בינואר", "בפברואר", "במרץ", "באפריל", "במאי", "ביוני", "ביולי", "באוגוסט", "בספטמבר", "באוקטובר", "בנובמבר", "בדצמבר"
        )

        // Long WhatsApp system notices: safe to match anywhere in the text.
        private val SYSTEM_PHRASES = listOf(
            "מוצפן מקצה לקצה", "הוגדרה פרטיות מוגברת", "לפרופיל ולמספר הטלפון", "ההצפנה מקצה לקצה"
        )

        // Short UI/status texts. Only treated as metadata when the text is short, so a real message that happens
        // to contain one of these words is NOT skipped.
        private val SHORT_SYSTEM_PHRASES = listOf(
            "הודעות שלא נקראו", "הודעה שלא נקראה", "הודעה חדשה", "הודעות חדשות", "unread message",
            "מחוברים", "עוקבים", "נראה לאחרונה", "הקלידו", "typing", "online",
            "הוספת תג", "תג החבר שלך", "הודעות זמניות", "הצגת אנשי קשר", "הצגת קבוצה"
        )
        private const val SHORT_SYSTEM_MAX_LEN = 30
    }

    private var activeChatTitle = DEFAULT_CHAT_TITLE
    private val handler = Handler(Looper.getMainLooper())
    private var scanPending = false

    // hash(chat|sender|text) -> time first reported. Hashed so message text is not kept in plain text on the phone.
    private val processed = LinkedHashMap<String, Long>()
    private var saveScheduled = false

    override fun onCreate() {
        super.onCreate()
        loadProcessedKeys()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        AlertSender.syncKeywords(applicationContext)
        AlertSender.flushPending(applicationContext)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        persistProcessedKeys()
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // Processed-message history (persisted, hashed, expiring)
    // ------------------------------------------------------------------
    private fun loadProcessedKeys() {
        try {
            val prefs = getSharedPreferences(AlertSender.PREFS, MODE_PRIVATE)
            val now = System.currentTimeMillis()
            val saved = prefs.getStringSet(PREF_PROCESSED, null)
            if (saved != null) {
                saved.mapNotNull { entry ->
                    val idx = entry.indexOf('|')
                    val time = if (idx > 0) entry.substring(idx + 1).toLongOrNull() else null
                    if (time != null && now - time < KEY_TTL_MS) entry.substring(0, idx) to time else null
                }.sortedBy { it.second }.forEach { processed[it.first] = it.second }
            }
            // Older versions stored message text itself in plain text; remove it.
            if (prefs.contains(PREF_PROCESSED_LEGACY)) prefs.edit().remove(PREF_PROCESSED_LEGACY).apply()
        } catch (e: Exception) {
            Log.e(TAG, "Error loading processed keys", e)
        }
    }

    private fun persistProcessedKeys() {
        saveScheduled = false
        try {
            val entries = processed.entries.map { "${it.key}|${it.value}" }.toSet()
            getSharedPreferences(AlertSender.PREFS, MODE_PRIVATE).edit().putStringSet(PREF_PROCESSED, entries).apply()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving processed keys", e)
        }
    }

    private fun schedulePersist() {
        if (saveScheduled) return
        saveScheduled = true
        handler.postDelayed({ persistProcessedKeys() }, SAVE_DELAY_MS)
    }

    private fun keyFor(chat: String, sender: String, text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$chat|$sender|$text".toByteArray(Charsets.UTF_8))
        return digest.take(8).joinToString("") { "%02x".format(it) }
    }

    /** Returns true if this message is new (and records it). */
    private fun markIfNew(key: String): Boolean {
        val now = System.currentTimeMillis()
        val seenAt = processed[key]
        if (seenAt != null && now - seenAt < KEY_TTL_MS) return false
        processed.remove(key)
        processed[key] = now
        while (processed.size > MAX_HISTORY_SIZE) {
            val eldest = processed.keys.iterator().next()
            processed.remove(eldest)
        }
        schedulePersist()
        return true
    }

    // ------------------------------------------------------------------
    // Event handling
    // ------------------------------------------------------------------
    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: return
        if (packageName !in WHATSAPP_PACKAGES) return

        // Both calls are throttled internally; they are cheap no-ops most of the time.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            AlertSender.syncKeywords(applicationContext)
        }
        AlertSender.flushIfDue(applicationContext)

        if (scanPending) return
        scanPending = true
        handler.postDelayed({
            scanPending = false
            scanScreen()
        }, SCAN_DELAY_MS)
    }

    override fun onInterrupt() {
        Log.d(TAG, "Service Interrupted")
    }

    @Suppress("DEPRECATION")
    private fun AccessibilityNodeInfo.release() {
        try {
            recycle()
        } catch (e: Exception) {
            // already recycled / not needed on newer Android versions
        }
    }

    private fun scanScreen() {
        val rootNode = rootInActiveWindow ?: return
        try {
            val pkg = rootNode.packageName?.toString() ?: return
            if (pkg !in WHATSAPP_PACKAGES) return
            detectChatTitle(rootNode, pkg)
            scanMessageBubbles(rootNode)
        } catch (e: Exception) {
            Log.e(TAG, "Scan failed", e)
        } finally {
            rootNode.release()
        }
    }

    /** Finds the chat title (contact or group name) at the top of the WhatsApp chat screen. */
    private fun detectChatTitle(rootNode: AccessibilityNodeInfo, pkg: String) {
        val list = rootNode.findAccessibilityNodeInfosByViewId("$pkg:id/conversation_contact_name")
        if (list.isNotEmpty()) {
            val titleText = list[0].text?.toString() ?: ""
            if (titleText.isNotEmpty() && titleText != activeChatTitle) {
                activeChatTitle = titleText
                Log.d(TAG, "Detected active chat")
            }
            return
        }
        // Fallback: the first TextView in the top bar
        findHeaderTextView(rootNode)
    }

    private fun findHeaderTextView(node: AccessibilityNodeInfo) {
        val density = resources.displayMetrics.density
        val minTop = (18 * density).toInt()
        val maxTop = (75 * density).toInt()
        val minLeft = (36 * density).toInt()
        val bounds = Rect()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (child.className == "android.widget.TextView") {
                child.getBoundsInScreen(bounds)
                if (bounds.top in minTop..maxTop && bounds.left > minLeft) {
                    val text = child.text?.toString() ?: ""
                    if (text.isNotEmpty() && text.length > 2 && text != activeChatTitle &&
                        !text.contains(":") && text != "WhatsApp" && text != DEFAULT_CHAT_TITLE) {
                        activeChatTitle = text
                        Log.d(TAG, "Fallback detected active chat")
                    }
                }
            }
            findHeaderTextView(child)
            child.release()
        }
    }

    /** Traverses the UI tree to locate message bubbles, filters out metadata, and checks for threats. */
    private fun scanMessageBubbles(rootNode: AccessibilityNodeInfo) {
        val messageNodes = mutableListOf<AccessibilityNodeInfo>()
        findMessageBubbleNodes(rootNode, messageNodes)

        val keywords = AlertSender.getKeywords(applicationContext)
        val prefs = applicationContext.getSharedPreferences(AlertSender.PREFS, Context.MODE_PRIVATE)
        val kidName = prefs.getString(AlertSender.PREF_KID_NAME, "הילד") ?: "הילד"

        for (node in messageNodes) {
            val text = node.text?.toString()?.trim() ?: continue
            if (text.isEmpty()) continue
            if (isMetadataOrTime(text)) continue

            val sender = getSenderName(node, activeChatTitle, kidName)

            if (markIfNew(keyFor(activeChatTitle, sender, text))) {
                AlertSender.addMessageToContext(activeChatTitle, sender, text)

                if (AlertSender.containsThreatKeyword(text, keywords)) {
                    Log.d(TAG, "Keyword filter triggered in a chat")
                    val chatContext = AlertSender.getChatContext(activeChatTitle)
                    AlertSender.sendAlert(applicationContext, activeChatTitle, sender, text, chatContext)
                }
            }
        }

        for (node in messageNodes) {
            node.release()
        }
    }

    // ------------------------------------------------------------------
    // Sender resolution
    // ------------------------------------------------------------------
    private fun getSenderName(node: AccessibilityNodeInfo, activeChat: String, kidName: String): String {
        val parent = node.parent
        if (parent != null) {
            val name = findNameInContainer(parent, node)
            if (name != null) {
                parent.release()
                return name
            }

            // Fallback: check grandparent siblings (nested layout structures)
            val grandparent = parent.parent
            if (grandparent != null) {
                val gpName = findNameInContainer(grandparent, node)
                if (gpName != null) {
                    grandparent.release()
                    parent.release()
                    return gpName
                }
                grandparent.release()
            }
            parent.release()
        }
        return deduceDefaultSender(node, activeChat, kidName)
    }

    private fun findNameInContainer(container: AccessibilityNodeInfo, targetNode: AccessibilityNodeInfo): String? {
        val bounds = Rect()
        targetNode.getBoundsInScreen(bounds)
        val targetText = targetNode.text?.toString()?.trim()

        for (i in 0 until container.childCount) {
            val child = container.getChild(i) ?: continue
            if (child.className == "android.widget.TextView") {
                val childText = child.text?.toString()?.trim() ?: ""
                if (childText.isNotEmpty() && !isMetadataOrTime(childText) && childText != targetText) {
                    val childBounds = Rect()
                    child.getBoundsInScreen(childBounds)
                    // The sender's name sits above the message text and overlaps it horizontally
                    // (works for LTR/RTL and for varying text lengths).
                    if (childBounds.top < bounds.top && childBounds.left < bounds.right && childBounds.right > bounds.left) {
                        child.release()
                        return childText
                    }
                }
            }
            child.release()
        }
        return null
    }

    /**
     * Decides whether a message was written by the kid or by the chat contact from its horizontal position.
     * The threshold scales with the screen width (it used to be a fixed 250px, which is wrong on other screens).
     */
    private fun deduceDefaultSender(node: AccessibilityNodeInfo, activeChat: String, kidName: String): String {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val threshold = resources.displayMetrics.widthPixels * 0.23f
        return if (bounds.left < threshold) {
            kidName
        } else {
            if (activeChat.isNotEmpty() && activeChat != DEFAULT_CHAT_TITLE && activeChat != "WhatsApp") activeChat else "הצד השני"
        }
    }

    /** Recursively collects text nodes. */
    @Suppress("DEPRECATION")
    private fun findMessageBubbleNodes(node: AccessibilityNodeInfo, messageNodes: MutableList<AccessibilityNodeInfo>) {
        if (node.className == "android.widget.TextView" && node.text != null) {
            messageNodes.add(AccessibilityNodeInfo.obtain(node))
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findMessageBubbleNodes(child, messageNodes)
            child.release()
        }
    }

    // ------------------------------------------------------------------
    // Noise filter: timestamps, dates, system notices, status lines.
    // Rules that match words must not swallow real (short) messages, e.g. a girl's name that is also a month.
    // ------------------------------------------------------------------
    private fun isMetadataOrTime(text: String): Boolean {
        val cleanText = text.trim()
        if (cleanText.length <= 1) return true

        if (cleanText.matches(TIME_REGEX)) return true
        if (cleanText.matches(PHONE_REGEX)) return true
        if (cleanText.matches(DATE_REGEX)) return true
        if (cleanText.matches(DAY_WORD_REGEX)) return true
        if (IGNORED_EXACT.contains(cleanText)) return true

        // Contact label of unsaved numbers, e.g. "Nadav sobel ~" or "~Nadav"
        if (cleanText.length <= 40 && (cleanText.startsWith("~") || cleanText.endsWith("~"))) return true

        for (phrase in SYSTEM_PHRASES) {
            if (cleanText.contains(phrase)) return true
        }

        if (cleanText.length < SHORT_SYSTEM_MAX_LEN) {
            for (phrase in SHORT_SYSTEM_PHRASES) {
                if (cleanText.contains(phrase)) return true
            }
        }

        // Date headers such as "8 ביולי" / "8 ביולי, 15:47" - requires a digit, so the names מאי / יולי / אפריל are not dropped.
        if (cleanText.length < 25 && cleanText.any { it.isDigit() }) {
            for (month in HEBREW_MONTHS) {
                if (cleanText.contains(month)) return true
            }
        }

        return false
    }
}
