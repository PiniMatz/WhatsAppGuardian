package com.guardian.client.services

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.guardian.client.utils.AlertSender

class WhatsAppNotificationListener : NotificationListenerService() {

    private val TAG = "WhatsAppNotification"

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != "com.whatsapp") return

        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""

        // Exclude system notifications (e.g., "Checking for new messages")
        if (title.isEmpty() || text.isEmpty() || text.contains("Checking for new messages")) return

        Log.d(TAG, "Notification from: $title - Message: $text")

        // Sync keywords dynamically in background
        AlertSender.syncKeywords(applicationContext)

        // Add message to rolling context cache
        AlertSender.addMessageToContext(title, title, text)

        val keywords = AlertSender.getKeywords(applicationContext)
        if (AlertSender.containsThreatKeyword(text, keywords)) {
            Log.d(TAG, "Notification message triggered keyword filter: $text")
            val contextList = AlertSender.getChatContext(title)
            AlertSender.sendAlert(applicationContext, title, title, text, contextList)
        }
    }
}
