package com.rajeev.mptracker;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/** window.SFXBMNative - lets the Asset Desk page switch phone notifications on/off for the logged-in user. */
public class NotifyBridge {
    static final String PREFS = "sfxbm_notify";
    private final Activity act;

    NotifyBridge(Activity a) { act = a; }

    @JavascriptInterface
    public void setAuth(final String base, final String token) {
        if (base == null || token == null || token.isEmpty()) return;
        SharedPreferences p = act.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!token.equals(p.getString("token", ""))) p.edit().remove("last").apply();   // new login -> start counting from now
        p.edit().putString("base", base).putString("token", token).apply();
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                askPermission();
                try { ContextCompat.startForegroundService(act, new Intent(act, NotifyService.class)); } catch (Exception ignored) { }
            }
        });
    }

    @JavascriptInterface
    public void clearAuth() {
        act.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.stopService(new Intent(act, NotifyService.class)); }
        });
    }

    @JavascriptInterface
    public boolean available() { return true; }

    private void askPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(act, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 77);
        }
    }
}
