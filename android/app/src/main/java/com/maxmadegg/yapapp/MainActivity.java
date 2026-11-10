package com.maxmadegg.yapapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Shows the shared chat UI (assets/www/index.html) in a WebView. The chat core
 * itself runs in YapService (so it keeps going in the background); this
 * activity binds to it and relays lines both ways:
 *
 * WebView --YapNative.post(line)--> YapService --> Bare worklet
 * WebView <--window.__yapRecv(line)-- YapService <-- Bare worklet
 */
public class MainActivity extends Activity {
  private WebView webView;
  private YapService service;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final List<String> pendingPosts = new ArrayList<>(); // lines sent before the service connected

  private final ServiceConnection connection = new ServiceConnection() {
    @Override
    public void onServiceConnected(ComponentName name, IBinder binder) {
      service = ((YapService.LocalBinder) binder).service();
      service.setListener(line -> {
        final String js = "window.__yapRecv && window.__yapRecv(" + JSONObject.quote(line) + ")";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(js, null); });
        maybeAskBatteryExemption(line);
      });
      service.setUiVisible(hasWindowFocus() || isResumedNow);
      for (String l : pendingPosts) service.post(l);
      pendingPosts.clear();
    }

    @Override
    public void onServiceDisconnected(ComponentName name) { service = null; }
  };

  private boolean isResumedNow;
  private Updater updater;
  private String updateVersion; // downloaded update waiting for the user

  private void showUpdate() {
    if (updateVersion == null || webView == null) return;
    String line = "{\"event\":\"update-ready\",\"data\":" + JSONObject.quote(updateVersion) + "}";
    webView.evaluateJavascript("window.__yapRecv && window.__yapRecv(" + JSONObject.quote(line) + ")", null);
  }

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    FrameLayout root = new FrameLayout(this);
    webView = new WebView(this);
    root.addView(webView);
    setContentView(root);
    applyInsets(root);

    WebSettings s = webView.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    webView.setBackgroundColor(0xff1e1f24);
    webView.addJavascriptInterface(new Bridge(), "YapNative");
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public void onPageFinished(WebView view, String url) { showUpdate(); }
    });
    updater = new Updater(this);

    // Bound now; also *started* in onResume (Android 12+ only allows that once
    // we're really in the foreground) so it can outlive this activity in a room.
    bindService(new Intent(this, YapService.class), connection, Context.BIND_AUTO_CREATE);

    if (Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
    }

    webView.loadUrl("file:///android_asset/www/index.html");
  }

  // Keep the UI clear of the status bar, navigation bar and the keyboard
  // (Android 15+ always draws apps edge-to-edge).
  private void applyInsets(View root) {
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      int l, t, r, b;
      if (Build.VERSION.SDK_INT >= 30) {
        Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
        l = i.left; t = i.top; r = i.right; b = i.bottom;
      } else {
        l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
        r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
      }
      v.setPadding(l, t, r, b);
      return WindowInsets.CONSUMED;
    });
  }

  // First time we're in a room, ask once to be exempt from battery
  // optimisation so Android doesn't cut the connection while the phone sleeps.
  private void maybeAskBatteryExemption(String line) {
    if (!line.contains("\"event\":\"status\"") || line.contains("\"room\":null")) return;
    mainHandler.post(() -> {
      SharedPreferences prefs = getSharedPreferences("yapapp", MODE_PRIVATE);
      if (prefs.getBoolean("askedBattery", false)) return;
      PowerManager pm = getSystemService(PowerManager.class);
      if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
      prefs.edit().putBoolean("askedBattery", true).apply();
      try {
        @SuppressLint("BatteryLife")
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:" + getPackageName()));
        startActivity(i);
      } catch (Exception ignored) {}
    });
  }

  /** Exposed to the page as window.YapNative (see assets/www/bridge.js). */
  private class Bridge {
    @JavascriptInterface
    public void post(String line) {
      mainHandler.post(() -> {
        if (service != null) service.post(line);
        else pendingPosts.add(line);
      });
    }

    @JavascriptInterface
    public void copy(String text) {
      ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
      cm.setPrimaryClip(ClipData.newPlainText("YapApp invite", text));
    }

    @JavascriptInterface
    public void installUpdate() { updater.install(); }

    @JavascriptInterface
    public String version() {
      try {
        PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
        return p.versionName;
      } catch (Exception e) {
        return "?";
      }
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    isResumedNow = true;
    try {
      startService(new Intent(this, YapService.class));
    } catch (IllegalStateException e) {
      // Background-start restriction; binding still works, retried on next resume.
    }
    if (service != null) service.setUiVisible(true);
    updater.checkAsync(false, v -> mainHandler.post(() -> { updateVersion = v; showUpdate(); }));
  }

  @Override
  protected void onPause() {
    super.onPause();
    isResumedNow = false;
    if (service != null) service.setUiVisible(false);
  }

  @Override
  protected void onDestroy() {
    if (service != null) service.setListener(null);
    unbindService(connection);
    service = null;
    if (webView != null) { webView.destroy(); webView = null; }
    super.onDestroy();
  }
}
