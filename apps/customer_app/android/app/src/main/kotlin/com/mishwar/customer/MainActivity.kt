package com.mishwar.customer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createRideUpdatesChannel()
    }

    private fun createRideUpdatesChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            "ride_updates",
            getString(R.string.ride_updates_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = getString(R.string.ride_updates_channel_description)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
