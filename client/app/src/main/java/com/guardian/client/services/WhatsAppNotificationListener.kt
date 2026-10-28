package com.guardian.client.services

import android.app.Notification
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.guardian.client.utils.AlertSender

class WhatsAppNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "WhatsAppNotification"
        private val WHATSAPP_PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")

        // "Alice (3 messages)" -> "Alice"
        private val COUNT_SUFFIX = Regex("\\s*\\(\\d+[^)]*\\)\\s*$")

        // "Alice: hello" (group notifications prefix the sender's name)
        private val SENDER_PREFIX = Regex("^([^:\\n]{1,40}):\\s+(.+)$", RegexOption.DOT_MATCHES_ALL)

        // Generic / summary notifications that are not real messages.
        private val IGNORED_TEXT = listOf(
            "Checking for new messages", "בודק אם יש הודעות חדשות", "WhatsApp Web", "מחובר ל-WhatsApp Web"
        )
        private val SUMMARY_TEXT = Regex("^\\d+\\s+(new messages|הודעות חדשות|הודעות)(\\s+from\\s+\\d+\\s+chats|\\s+מ-?\\d+\\s+שיחות)?$", RegexOption.IGNORE_CASE)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        AlertSender.syncKeywords(applicationContext)
        AlertSender.flushPending(applicationContext)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in WHATSAPP_PACKAGES) return

        val notification = sbn.notification
        // Summary notifications only repeat the individual ones.
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""

        if (title.isEmpty() || text.isEmpty()) return
        if (IGNORED_TEXT.any { text.contains(it, ignoreCase = true) }) return
        if (SUMMARY_TEXT.matches(text)) return

        val chatName = COUNT_SUFFIX.replace(title, "").trim().ifEmpty { title }

        var sender = chatName
        var message = text
        val isGroup = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        if (isGroup) {
            val match = SENDER_PREFIX.find(text)
            if (match != null) {
                sender = match.groupValues[1].trim()
                message = match.groupValues[2].trim()
            }
        }

        Log.d(TAG, "WhatsApp notification received")

        // Throttled internally, safe to call on every notification.
        AlertSender.syncKeywords(applicationContext)
        AlertSender.flushIfDue(applicationContext)

        AlertSender.addMessageToContext(chatName, sender, message)

        val keywords = AlertSender.getKeywords(applicationContext)
        if (AlertSender.containsThreatKeyword(message, keywords)) {
            val contextList = AlertSender.getChatContext(chatName)
            AlertSender.sendAlert(applicationContext, chatName, sender, message, contextList)
        }
    }
}
