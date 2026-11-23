package com.rajeev.mptracker;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // gate tablet / supervisor scanning: keep the screen on while the app is open
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // phone notifications for the Asset Desk page (window.SFXBMNative)
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new NotifyBridge(this), "SFXBMNative");
        }
        // every page opened in the app (also server pages like the login) can read the installed version: "SFXBM/<version>" in the user agent
        try {
            String ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            if (getBridge() != null && getBridge().getWebView() != null) {
                android.webkit.WebSettings ws = getBridge().getWebView().getSettings();
                ws.setUserAgentString(ws.getUserAgentString() + " SFXBM/" + ver);
            }
        } catch (Exception ignored) { }
        // camera result sounds without an extra tap
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
