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
import com.guardian.client.services.WhatsAppAccessibilityService

class MainActivity : AppCompatActivity() {

    private lateinit var etKidName: EditText
    private lateinit var btnSaveName: Button
    private lateinit var btnAccessibility: Button
    private lateinit var btnNotifications: Button
    private lateinit var tvStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etKidName = findViewById(R.id.et_kid_name)
        btnSaveName = findViewById(R.id.btn_save_name)
        btnAccessibility = findViewById(R.id.btn_accessibility)
        btnNotifications = findViewById(R.id.btn_notifications)
        tvStatus = findViewById(R.id.tv_status)

        // Load existing name if saved
        val sharedPreferences = getSharedPreferences("GuardianPrefs", Context.MODE_PRIVATE)
        val savedName = sharedPreferences.getString("kid_name", "")
        if (!TextUtils.isEmpty(savedName)) {
            etKidName.setText(savedName)
        }

        btnSaveName.setOnClickListener {
            val name = etKidName.text.toString().trim()
            if (TextUtils.isEmpty(name)) {
                Toast.makeText(this, "אנא הזן שם ילד תקין", Toast.LENGTH_SHORT).show()
            } else {
                sharedPreferences.edit().putString("kid_name", name).apply()
                Toast.makeText(this, "שם הילד נשמר בהצלחה: $name", Toast.LENGTH_SHORT).show()
            }
        }

        btnAccessibility.setOnClickListener {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            startActivity(intent)
        }

        btnNotifications.setOnClickListener {
            val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
            startActivity(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        updateServiceStatus()
    }

    private fun updateServiceStatus() {
        val accessibilityEnabled = isAccessibilityServiceEnabled(this, WhatsAppAccessibilityService::class.java)
        val notificationEnabled = isNotificationServiceEnabled(this)
        
        when {
            accessibilityEnabled && notificationEnabled -> {
                tvStatus.text = "סטטוס שירות: הכל מוגדר בהצלחה ופעיל! 🛡️"
                tvStatus.setTextColor(resources.getColor(android.R.color.holo_green_light, null))
            }
            accessibilityEnabled -> {
                tvStatus.text = "סטטוס שירות: נגישות פעילה, חסר אישור גישה להתראות"
                tvStatus.setTextColor(resources.getColor(android.R.color.holo_orange_light, null))
            }
            notificationEnabled -> {
                tvStatus.text = "סטטוס שירות: גישה להתראות פעילה, חסר אישור נגישות"
                tvStatus.setTextColor(resources.getColor(android.R.color.holo_orange_light, null))
            }
            else -> {
                tvStatus.text = "סטטוס שירות: כבוי (יש לאפשר נגישות והתראות)"
                tvStatus.setTextColor(resources.getColor(android.R.color.holo_red_light, null))
            }
        }
    }

    private fun isAccessibilityServiceEnabled(context: Context, service: Class<*>): Boolean {
        val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
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
