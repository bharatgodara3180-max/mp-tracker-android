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
        // camera result sounds without an extra tap
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
