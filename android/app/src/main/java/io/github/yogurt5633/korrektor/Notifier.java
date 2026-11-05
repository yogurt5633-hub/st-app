package io.github.yogurt5633.korrektor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** Android notifications: new cards from Korrektor and available updates. */
final class Notifier {
    private static final String CHANNEL = "korrektor";

    private Notifier() {
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Корректор", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Новые замечания и обновления");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static boolean allowed(Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        return nm == null || nm.areNotificationsEnabled();
    }

    static void show(Context context, int id, String title, String text, String tab) {
        if (!allowed(context)) return;
        Intent open = new Intent(context, MainActivity.class);
        open.putExtra("tab", tab);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pending)
                .setAutoCancel(true);
        context.getSystemService(NotificationManager.class).notify(id, builder.build());
    }
}
