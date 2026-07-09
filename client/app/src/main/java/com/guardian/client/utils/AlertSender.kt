package com.guardian.client.utils

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.IOException

object AlertSender {
    private const val TAG = "AlertSender"
    
    // Change this IP to your backend server's IP address (e.g., http://192.168.1.15:3000)
    // 10.0.2.2 is the default IP to access your hosting computer's localhost from the Android emulator.
    const val SERVER_URL = "http://10.221.219.12:3000"

    private val client = OkHttpClient()
    private val gson = Gson()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // Store in-memory context of the last few messages for threat context
    private val chatContexts = mutableMapOf<String, MutableList<ContextMessage>>()

    data class ContextMessage(val sender: String, val text: String)
    data class AlertPayload(val kid_name: String, val target_text: String, val context: List<ContextMessage>)

    /**
     * Adds a message to the local rolling context for a specific chat.
     */
    fun addMessageToContext(chatId: String, sender: String, text: String) {
        val list = chatContexts.getOrPut(chatId) { mutableListOf() }
        list.add(ContextMessage(sender, text))
        if (list.size > 5) {
            list.removeAt(0) // keep only last 5 messages
        }
    }

    /**
     * Fetches the context list for a chat, excluding the very last message (which is the target).
     */
    fun getChatContext(chatId: String): List<ContextMessage> {
        val list = chatContexts[chatId] ?: return emptyList()
        return if (list.isNotEmpty()) list.dropLast(1) else emptyList()
    }

    /**
     * Clears context for a chat when switching chats.
     */
    fun clearChatContext(chatId: String) {
        chatContexts.remove(chatId)
    }

    /**
     * Checks if a message contains any Hebrew threat keyword.
     */
    fun containsThreatKeyword(text: String, keywords: List<String>): Boolean {
        val lowercaseText = text.lowercase()
        for (keyword in keywords) {
            if (lowercaseText.contains(keyword.lowercase())) {
                return true
            }
        }
        return false
    }

    /**
     * Sends the flagged message with context to the backend.
     */
    fun sendAlert(context: Context, targetText: String, chatContext: List<ContextMessage>) {
        val sharedPreferences = context.getSharedPreferences("GuardianPrefs", Context.MODE_PRIVATE)
        val kidName = sharedPreferences.getString("kid_name", "שומר") ?: "שומר"

        val payload = AlertPayload(kidName, targetText, chatContext)
        val jsonPayload = gson.toJson(payload)

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val body = jsonPayload.toRequestBody(jsonMediaType)
                val request = Request.Builder()
                    .url("$SERVER_URL/api/alerts")
                    .post(body)
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        Log.e(TAG, "Server error sending alert: ${response.code}")
                    } else {
                        Log.d(TAG, "Alert sent successfully for $kidName: $targetText")
                    }
                }
            } catch (e: IOException) {
                Log.e(TAG, "Network error sending alert: ${e.message}")
            }
        }
    }

    data class KeywordResponse(val keywords: List<String>)

    /**
     * Gets the list of Hebrew keywords for threat matching.
     * Falls back to a default list if nothing is cached from the server.
     */
    fun getKeywords(context: Context): List<String> {
        val sharedPreferences = context.getSharedPreferences("GuardianPrefs", Context.MODE_PRIVATE)
        val json = sharedPreferences.getString("cached_keywords", null) ?: return listOf(
            // Physical violence & Threats
            "מכות", "להרוג", "נדקור", "סכין", "לרצוח", "אשבור לך", "נביא לך", 
            "לפוצץ אותך", "ניפגש בחוץ", "נרביץ", "אגרוף", "כאפה", "כאפות", "לכסח",
            // Bullying & Social Exclusion
            "חרם", "אל תדברו", "להעיף", "נעיף", "מנודה", "אף אחד לא אוהב", "סרטן", "תמות", "תתאבד",
            // Swears & Slurs (common among ages 9-12)
            "הומו", "מפגר", "מפגרת", "סתומה", "סתום", "טיפש", "טיפשה", "זונה", "שרמוטה", "קוקסינל", 
            "מכוער", "מכוערת", "שמן", "שמנה", "אוטיסט", "נכה", "כלבה", "כלב"
        )
        return try {
            gson.fromJson(json, Array<String>::class.java).toList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Fetches keywords list from the server backend and caches them locally.
     */
    fun syncKeywords(context: Context) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val request = Request.Builder()
                    .url("$SERVER_URL/api/config/keywords")
                    .get()
                    .build()

                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val bodyText = response.body?.string()
                        if (bodyText != null) {
                            val res = gson.fromJson(bodyText, KeywordResponse::class.java)
                            val keywordsJson = gson.toJson(res.keywords)
                            context.getSharedPreferences("GuardianPrefs", Context.MODE_PRIVATE)
                                .edit()
                                .putString("cached_keywords", keywordsJson)
                                .apply()
                            Log.d(TAG, "Keywords synced successfully: ${res.keywords.size} words")
                        }
                    }
                }
            } catch (e: IOException) {
                Log.e(TAG, "Network error syncing keywords: ${e.message}")
            }
        }
    }
}
