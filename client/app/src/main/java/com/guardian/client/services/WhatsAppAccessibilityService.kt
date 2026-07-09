package com.guardian.client.services

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.guardian.client.utils.AlertSender
import java.util.Calendar

class WhatsAppAccessibilityService : AccessibilityService() {

    private const val TAG = "WhatsAppAccessibility"
    private var activeChatTitle = "וואטסאפ"
    
    // Set to store recently processed messages to prevent duplicate alerts
    private val processedMessageKeys = LinkedHashSet<String>()
    private val MAX_HISTORY_SIZE = 100

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: ""
        if (packageName != "com.whatsapp") return

        // Periodic keyword sync (triggered on activity change)
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            AlertSender.syncKeywords(applicationContext)
        }

        val rootNode = rootInActiveWindow ?: return
        
        // Step 1: Detect and update the active chat title (e.g. name of the contact or group)
        detectChatTitle(rootNode)

        // Step 2: Scan all message bubbles on screen
        scanMessageBubbles(rootNode)
        
        rootNode.recycle()
    }

    override fun onInterrupt() {
        Log.d(TAG, "Service Interrupted")
    }

    /**
     * Finds the chat title (contact or group name) at the top of the WhatsApp chat screen.
     */
    private fun detectChatTitle(rootNode: AccessibilityNodeInfo) {
        // WhatsApp Toolbar text usually contains the contact/group name
        // We look for TextViews inside the actionbar or top header
        val list = rootNode.findAccessibilityNodeInfosByViewId("com.whatsapp:id/conversation_contact_name")
        if (list.isNotEmpty()) {
            val titleText = list[0].text?.toString() ?: ""
            if (titleText.isNotEmpty() && titleText != activeChatTitle) {
                activeChatTitle = titleText
                Log.d(TAG, "Detected active chat: $activeChatTitle")
                // Clear context for the new chat to start fresh
                AlertSender.clearChatContext(activeChatTitle)
            }
            return
        }

        // Fallback: Look for the first TextView that is likely the header
        findHeaderTextView(rootNode)
    }

    private fun findHeaderTextView(node: AccessibilityNodeInfo) {
        val bounds = Rect()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (child.className == "android.widget.TextView") {
                child.getBoundsInScreen(bounds)
                // The contact name is usually at the top bar (Y coordinate between 50 and 200)
                if (bounds.top in 50..200 && bounds.left > 100) {
                    val text = child.text?.toString() ?: ""
                    if (text.isNotEmpty() && text.length > 2 && text != activeChatTitle && 
                        !text.contains(":") && text != "WhatsApp" && text != "וואטסאפ") {
                        activeChatTitle = text
                        Log.d(TAG, "Fallback detected active chat: $activeChatTitle")
                    }
                }
            }
            findHeaderTextView(child)
            child.recycle()
        }
    }

    /**
     * Traverses the UI tree to locate message bubbles, filter out metadata, and check for threat alerts.
     */
    private fun scanMessageBubbles(rootNode: AccessibilityNodeInfo) {
        val messageNodes = mutableListOf<AccessibilityNodeInfo>()
        findMessageBubbleNodes(rootNode, messageNodes)

        val keywords = AlertSender.getKeywords(applicationContext)
        val sharedPrefs = applicationContext.getSharedPreferences("GuardianPrefs", android.content.Context.MODE_PRIVATE)
        val kidName = sharedPrefs.getString("kid_name", "הילד") ?: "הילד"

        for (node in messageNodes) {
            val text = node.text?.toString()?.trim() ?: continue
            if (text.isEmpty()) continue

            // Heuristic to ignore timestamp texts (e.g., "11:34", "11:34 AM", "אתמול")
            if (isMetadataOrTime(text)) continue

            // Dynamic Sender Name extraction (from group bubble header, or fallback to contact/kid name)
            val sender = getSenderName(node, activeChatTitle, kidName)

            val messageKey = "${activeChatTitle}_${sender}_${text}"
            
            // Check if this message was already analyzed in this session
            if (!processedMessageKeys.contains(messageKey)) {
                Log.d(TAG, "New message in [$activeChatTitle] from $sender: $text")
                
                // Add to history
                processedMessageKeys.add(messageKey)
                if (processedMessageKeys.size > MAX_HISTORY_SIZE) {
                    val firstKey = processedMessageKeys.iterator().next()
                    processedMessageKeys.remove(firstKey)
                }

                // Add to context cache
                AlertSender.addMessageToContext(activeChatTitle, sender, text)

                // Run local keyword matching
                if (AlertSender.containsThreatKeyword(text, keywords)) {
                    Log.d(TAG, "Triggered keyword filter on text: $text")
                    val chatContext = AlertSender.getChatContext(activeChatTitle)
                    AlertSender.sendAlert(applicationContext, text, chatContext)
                }
            }
        }

        // Recycle all nodes in the list
        for (node in messageNodes) {
            node.recycle()
        }
    }

    /**
     * Extracts the sender name from group message bubble structure, or falls back to LTR/RTL screen alignment.
     */
    private fun getSenderName(node: AccessibilityNodeInfo, activeChat: String, kidName: String): String {
        val parent = node.parent
        if (parent != null) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            
            // Search sibling TextViews in the bubble to see if there is a name tag at the top
            for (i in 0 until parent.childCount) {
                val child = parent.getChild(i) ?: continue
                if (child.className == "android.widget.TextView") {
                    val childText = child.text?.toString()?.trim() ?: ""
                    if (childText.isNotEmpty() && !isMetadataOrTime(childText) && childText != node.text?.toString()?.trim()) {
                        val childBounds = Rect()
                        child.getBoundsInScreen(childBounds)
                        // In WhatsApp group layouts, the sender's name is placed strictly above the message text
                        if (childBounds.top < bounds.top && childBounds.left >= bounds.left - 50) {
                            val name = childText
                            child.recycle()
                            parent.recycle()
                            return name
                        }
                    }
                }
                child.recycle()
            }
            parent.recycle()
        }
        
        return deduceDefaultSender(node, activeChat, kidName)
    }

    /**
     * Deduces whether the message was sent by the kid or the chat contact based on left/right alignment.
     */
    private fun deduceDefaultSender(node: AccessibilityNodeInfo, activeChat: String, kidName: String): String {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        // Heuristic: Outgoing bubbles are aligned to the left/right edges depending on RTL settings.
        // Usually, in Hebrew/RTL system layout, outgoing bubbles (sent by kid) are on the left (< 250px).
        return if (bounds.left < 250) kidName else activeChat
    }

    /**
     * Recursively traverses nodes to find text nodes containing messages.
     */
    private fun findMessageBubbleNodes(node: AccessibilityNodeInfo, messageNodes: MutableList<AccessibilityNodeInfo>) {
        if (node.className == "android.widget.TextView" && node.text != null) {
            // Add a copy of the node to the list
            messageNodes.add(AccessibilityNodeInfo.obtain(node))
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findMessageBubbleNodes(child, messageNodes)
            child.recycle()
        }
    }

    /**
     * Helper to filter out layout elements like status, time, read ticks, etc.
     */
    private fun isMetadataOrTime(text: String): Boolean {
        // Match standard WhatsApp timestamps (e.g. 11:34, 11:34 AM, 23:59)
        val timeRegex = Regex("^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](\\s?(AM|PM))?$")
        // Match words like "yesterday", "today", read checkmarks, or short numbers
        val cleanText = text.trim()
        return cleanText.matches(timeRegex) || 
               cleanText == "אתמול" || 
               cleanText == "היום" || 
               cleanText.length <= 1 || 
               cleanText == "נמסר" || 
               cleanText == "נקרא"
    }
}
