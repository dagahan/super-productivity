package com.superproductivity.superproductivity.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.superproductivity.superproductivity.CapacitorMainActivity
import com.superproductivity.superproductivity.R

object BluetoothSyncNotificationHelper {
    const val PROGRESS_CHANNEL_ID = "sp_bluetooth_sync_progress_channel"
    const val FAILURE_CHANNEL_ID = "sp_bluetooth_sync_failure_channel"
    const val PROGRESS_NOTIFICATION_ID = 1010
    const val FAILURE_NOTIFICATION_ID = 1011

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                PROGRESS_CHANNEL_ID,
                "Bluetooth sync",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows progress while syncing with your other devices"
                setShowBadge(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                FAILURE_CHANNEL_ID,
                "Bluetooth sync problems",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Tells you when a sync could not finish"
            }
        )
    }

    fun showProgress(context: Context) {
        createChannels(context)
        val notification = NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sp)
            .setContentTitle("Syncing over Bluetooth")
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openAppIntent(context))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        NotificationManagerCompat.from(context)
            .notify(PROGRESS_NOTIFICATION_ID, notification)
    }

    fun hideProgress(context: Context) {
        NotificationManagerCompat.from(context).cancel(PROGRESS_NOTIFICATION_ID)
    }

    fun showFailure(context: Context, reason: String) {
        createChannels(context)
        hideProgress(context)
        val notification = NotificationCompat.Builder(context, FAILURE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sp)
            .setContentTitle("Bluetooth sync did not finish")
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .setAutoCancel(false)
            .setOngoing(false)
            .setContentIntent(openAppIntent(context))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context)
            .notify(FAILURE_NOTIFICATION_ID, notification)
    }

    private fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, CapacitorMainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            11,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
