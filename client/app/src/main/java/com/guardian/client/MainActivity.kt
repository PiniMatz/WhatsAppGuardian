package com.guardian.client

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.guardian.client.services.WhatsAppAccessibilityService
import com.guardian.client.utils.AlertSender
import java.text.DateFormat
import java.util.Date

class MainActivity : AppCompatActivity() {

    private lateinit var etKidName: EditText
    private lateinit var btnSaveName: Button
    private lateinit var btnAccessibility: Button
    private lateinit var btnNotifications: Button
    private lateinit var btnBattery: Button
    private lateinit var btnTestConnection: Button
    private lateinit var tvStatus: TextView
    private lateinit var tvDiag: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etKidName = findViewById(R.id.et_kid_name)
        btnSaveName = findViewById(R.id.btn_save_name)
        btnAccessibility = findViewById(R.id.btn_accessibility)
        btnNotifications = findViewById(R.id.btn_notifications)
        btnBattery = findViewById(R.id.btn_battery)
        btnTestConnection = findViewById(R.id.btn_test_connection)
        tvStatus = findViewById(R.id.tv_status)
        tvDiag = findViewById(R.id.tv_diag)

        val sharedPreferences = getSharedPreferences(AlertSender.PREFS, MODE_PRIVATE)
        val savedName = sharedPreferences.getString(AlertSender.PREF_KID_NAME, "")
        if (!TextUtils.isEmpty(savedName)) {
            etKidName.setText(savedName)
        }

        btnSaveName.setOnClickListener {
            val name = etKidName.text.toString().trim()
            if (TextUtils.isEmpty(name)) {
                Toast.makeText(this, "אנא הזן שם ילד תקין", Toast.LENGTH_SHORT).show()
            } else {
                sharedPreferences.edit { putString(AlertSender.PREF_KID_NAME, name) }
                Toast.makeText(this, "שם הילד נשמר בהצלחה: $name", Toast.LENGTH_SHORT).show()
            }
        }

        btnAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        btnNotifications.setOnClickListener {
            startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
        }

        // Many phones (Samsung, Xiaomi, ...) stop background services to save battery; exclude this app.
        btnBattery.setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_SETTINGS))
            }
            Toast.makeText(this, "יש לבחור 'כל האפליקציות', לחפש את WhatsApp Guardian ולבחור 'ללא הגבלה / לא לבצע אופטימיזציה'", Toast.LENGTH_LONG).show()
        }

        btnTestConnection.setOnClickListener {
            btnTestConnection.isEnabled = false
            tvDiag.text = "בודק חיבור... (אם השרת היה רדום זה יכול לקחת עד דקה)"
            AlertSender.testConnection(this) { ok, message ->
                btnTestConnection.isEnabled = true
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                updateDiagnostics(if (ok) null else message)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        updateServiceStatus()
        updateDiagnostics(null)
        AlertSender.flushPending(this)
    }

    private fun formatTime(millis: Long): String {
        return if (millis <= 0L) "אף פעם" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(millis))
    }

    private fun updateDiagnostics(extra: String?) {
        val prefs = getSharedPreferences(AlertSender.PREFS, MODE_PRIVATE)
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (e: Exception) {
            "?"
        }
        val lines = mutableListOf<String>()
        lines.add("גרסה: $version")
        lines.add("שרת: ${AlertSender.SERVER_URL}")
        lines.add("סנכרון מילות מפתח אחרון: ${formatTime(prefs.getLong(AlertSender.PREF_LAST_SYNC_OK, 0L))}")
        lines.add("שליחת התרעה מוצלחת אחרונה: ${formatTime(prefs.getLong(AlertSender.PREF_LAST_SEND_OK, 0L))}")
        val pending = AlertSender.pendingCount(this)
        if (pending > 0) {
            lines.add("התרעות שממתינות לשליחה: $pending (${prefs.getString(AlertSender.PREF_LAST_SEND_ERROR, "ממתין") ?: "ממתין"})")
        }
        if (extra != null) lines.add(extra)
        tvDiag.text = lines.joinToString("\n")
    }

    private fun updateServiceStatus() {
        val accessibilityEnabled = isAccessibilityServiceEnabled(this, WhatsAppAccessibilityService::class.java)
        val notificationEnabled = isNotificationServiceEnabled(this)

        when {
            accessibilityEnabled && notificationEnabled -> {
                tvStatus.text = "סטטוס שירות: הכל מוגדר בהצלחה ופעיל! 🛡️"
                tvStatus.setTextColor(ContextCompat.getColor(this, android.R.color.holo_green_light))
            }
            accessibilityEnabled -> {
                tvStatus.text = "סטטוס שירות: נגישות פעילה, חסר אישור גישה להתראות"
                tvStatus.setTextColor(ContextCompat.getColor(this, android.R.color.holo_orange_light))
            }
            notificationEnabled -> {
                tvStatus.text = "סטטוס שירות: גישה להתראות פעילה, חסר אישור נגישות"
                tvStatus.setTextColor(ContextCompat.getColor(this, android.R.color.holo_orange_light))
            }
            else -> {
                tvStatus.text = "סטטוס שירות: כבוי (יש לאפשר נגישות והתראות)"
                tvStatus.setTextColor(ContextCompat.getColor(this, android.R.color.holo_red_light))
            }
        }
    }

    private fun isAccessibilityServiceEnabled(context: Context, service: Class<*>): Boolean {
        val am = context.getSystemService(ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabledServices = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_GENERIC)
        for (enabledService in enabledServices) {
            val enabledServiceInfo = enabledService.resolveInfo.serviceInfo
            if (enabledServiceInfo.packageName == context.packageName && enabledServiceInfo.name == service.name) {
                return true
            }
        }
        return false
    }

    private fun isNotificationServiceEnabled(context: Context): Boolean {
        val pkgName = context.packageName
        val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
        if (!TextUtils.isEmpty(flat)) {
            val names = flat.split(":")
            for (name in names) {
                val cn = ComponentName.unflattenFromString(name)
                if (cn != null && TextUtils.equals(pkgName, cn.packageName)) {
                    return true
                }
            }
        }
        return false
    }
}
