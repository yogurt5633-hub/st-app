package io.github.yogurt5633.korrektor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * While the tavern is open in the app, a quiet ongoing notification «Таверна открыта».
 * With it Android treats the app like a music player: it is not unloaded when many
 * other apps are opened, so the tavern page does not reload on return.
 * Nothing runs here; the service only marks the app as being in use.
 */
public final class KeepAliveService extends Service {
    private static final String CHANNEL = "keep_alive";
    private static final int ID = 4242;
    private static final String STOP = "stop";
    // ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE (Android 14)
    private static final int TYPE_SPECIAL_USE = 0x40000000;

    static void start(Context context) {
        if (!new Prefs(context).flag(Prefs.KEEP_ALIVE, true)) return;
        Intent intent = new Intent(context, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception ignored) {
            // Android does not allow it from the background: it starts next time the app is on screen
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, KeepAliveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            new Prefs(this).setFlag(Prefs.KEEP_ALIVE, false);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification notification = build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, TYPE_SPECIAL_USE);
            else startForeground(ID, notification);
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification build() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Таверна открыта", NotificationManager.IMPORTANCE_MIN);
            channel.setDescription("Пока таверна открыта, Android не выгружает приложение и страница не перезагружается");
            channel.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.putExtra("tab", "tavern");
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, KeepAliveService.class).setAction(STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this).setPriority(Notification.PRIORITY_MIN);
        builder.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Таверна открыта")
                .setContentText("Не перезагрузится, пока вы в других приложениях")
                .setContentIntent(openPending)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Не держать", stopPending).build());
        return builder.build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: nothing to keep.
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
