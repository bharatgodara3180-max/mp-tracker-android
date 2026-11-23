package com.rajeev.mptracker;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import java.util.Locale;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/** window.SFXBMNative - lets the Asset Desk page switch phone notifications on/off for the logged-in user. */
public class NotifyBridge {
    static final String PREFS = "sfxbm_notify";
    private final Activity act;

    NotifyBridge(Activity a) { act = a; }

    // ---- speak a name aloud (gate operator success scan): phone's own text-to-speech, Hindi (Google Hindi) voice
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String ttsPending = null;
    private float ttsRate = 0.85f;

    private void say(String text) {
        if (tts == null || !ttsReady) { ttsPending = text; return; }
        tts.setSpeechRate(ttsRate);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "sfxbm-name");
    }

    @JavascriptInterface
    public void speak(final String text, final float rate) {
        if (text == null || text.trim().isEmpty()) return;
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (rate > 0.3f && rate < 2f) ttsRate = rate;
                    if (tts == null) {
                        ttsPending = text;
                        tts = new TextToSpeech(act.getApplicationContext(), new TextToSpeech.OnInitListener() {
                            @Override public void onInit(int status) {
                                if (status != TextToSpeech.SUCCESS) return;
                                int r = tts.setLanguage(new Locale("hi", "IN"));
                                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(new Locale("en", "IN"));
                                ttsReady = true;
                                if (ttsPending != null) { String t = ttsPending; ttsPending = null; say(t); }
                            }
                        });
                    } else say(text);
                } catch (Exception ignored) { }
            }
        });
    }

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
