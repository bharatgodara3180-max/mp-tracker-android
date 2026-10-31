package com.rajeev.mptracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** Keeps asking the Asset Desk server for new notifications of the logged-in operator and shows them as phone notifications. */
public class NotifyService extends Service {
    private static final String CH_ALERT = "sfxbm_alerts";
    private static final String CH_KEEP = "sfxbm_keep";
    private volatile boolean running = false;
    private Thread worker;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        makeChannels();
        Notification keep = new NotificationCompat.Builder(this, CH_KEEP)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("SFXBM")
                .setContentText("Notifications are on")
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, keep, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(1, keep);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; }
        if (!running) {
            running = true;
            worker = new Thread(new Runnable() { @Override public void run() { loop(); } });
            worker.start();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }

    private void makeChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel a = new NotificationChannel(CH_ALERT, "Asset Desk alerts", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(a);
        NotificationChannel k = new NotificationChannel(CH_KEEP, "Background connection", NotificationManager.IMPORTANCE_MIN);
        nm.createNotificationChannel(k);
    }

    private void loop() {
        while (running) {
            try { poll(); } catch (Exception ignored) { }
            try { Thread.sleep(20000); } catch (InterruptedException e) { return; }
        }
    }

    private void poll() throws Exception {
        SharedPreferences p = getSharedPreferences(NotifyBridge.PREFS, Context.MODE_PRIVATE);
        String base = p.getString("base", null);
        String token = p.getString("token", null);
        if (base == null || token == null) { running = false; stopSelf(); return; }
        HttpURLConnection c = (HttpURLConnection) new URL(base + "api/notifications").openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        if (code == 401) { p.edit().clear().apply(); running = false; stopSelf(); return; }
        if (code != 200) return;
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        JSONArray items = new JSONObject(sb.toString()).getJSONArray("items");
        long last = p.getLong("last", -1);
        long max = Math.max(last, 0);
        for (int i = items.length() - 1; i >= 0; i--) {          // oldest first
            JSONObject n = items.getJSONObject(i);
            long id = n.getLong("id");
            if (id > max) max = id;
            if (last >= 0 && id > last && !n.optBoolean("read", false)) show((int) (id % 100000) + 100, n.optString("title"), n.optString("body"));
        }
        p.edit().putLong("last", max).apply();                   // first run only sets the starting point (no flood of old alerts)
    }

    private void show(int id, String title, String body) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CH_ALERT)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_ALL)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        try { ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, n); } catch (Exception ignored) { }
    }
}
