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
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.content.ContentValues;
import android.database.Cursor;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import org.json.JSONArray;
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

    /** System file picker (several files); result goes to window.__yapPicked. */
    @JavascriptInterface
    public void pickFiles() {
      mainHandler.post(() -> {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
          .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(i, REQ_PICK); }
        catch (Exception e) { deliverPicked(new JSONArray()); }
      });
    }

    /** Copy a decrypted export (files/export/...) into Downloads/YapApp/<relName>, then delete it. */
    @JavascriptInterface
    public boolean saveToDownloads(String path, String relName, String mime) {
      File src = new File(path);
      try {
        File exportDir = new File(getFilesDir(), "export").getCanonicalFile();
        if (!src.getCanonicalPath().startsWith(exportDir.getPath() + File.separator)) return false;
        StringBuilder dir = new StringBuilder(Environment.DIRECTORY_DOWNLOADS + "/YapApp");
        String[] parts = relName.split("[/\\\\]+");
        String name = "file";
        for (int k = 0; k < parts.length; k++) {
          String part = parts[k].replaceAll("[\\x00-\\x1f<>:\"|?*]", "_").trim();
          if (part.isEmpty() || part.equals(".") || part.equals("..")) continue;
          if (k == parts.length - 1) name = part; else dir.append('/').append(part);
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir.toString());
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) return false;
        try (InputStream in = new FileInputStream(src); OutputStream out = getContentResolver().openOutputStream(uri)) {
          byte[] buf = new byte[65536];
          int n;
          while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return true;
      } catch (Exception e) {
        return false;
      } finally {
        src.delete();
      }
    }

    /** Xiaomi/MIUI only: true when its "Autostart" switch is off for us, which blocks
     *  BootReceiver (no reconnect after a reboot). MIUI turns it off after every update. */
    @JavascriptInterface
    public boolean autostartBlocked() {
      if (!"xiaomi".equalsIgnoreCase(Build.MANUFACTURER)) return false;
      try {
        android.app.AppOpsManager ops = (android.app.AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
        java.lang.reflect.Method m = android.app.AppOpsManager.class.getMethod("checkOpNoThrow", int.class, int.class, String.class);
        int mode = (Integer) m.invoke(ops, 10008, android.os.Process.myUid(), getPackageName()); // MIUI OP_AUTO_START
        return mode != android.app.AppOpsManager.MODE_ALLOWED;
      } catch (Throwable e) {
        return false; // can't tell: don't nag
      }
    }

    /** Opens MIUI's Autostart screen (falls back to this app's settings page). */
    @JavascriptInterface
    public void openAutostart() {
      mainHandler.post(() -> {
        Intent i = new Intent().setComponent(new ComponentName("com.miui.securitycenter",
          "com.miui.permcenter.autostart.AutoStartManagementActivity"));
        try { startActivity(i); return; } catch (Exception ignored) {}
        try {
          startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {}
      });
    }

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

  static final int REQ_PICK = 4242;
  static final long MAX_PICK = 50L * 1024 * 1024;

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQ_PICK) return;
    List<Uri> uris = new ArrayList<>();
    if (resultCode == RESULT_OK && data != null) {
      if (data.getClipData() != null) {
        for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
      } else if (data.getData() != null) {
        uris.add(data.getData());
      }
    }
    // Copy off the UI thread into files/import/, then hand the paths to the page.
    new Thread(() -> {
      JSONArray out = new JSONArray();
      File dir = new File(getFilesDir(), "import");
      dir.mkdirs();
      for (Uri u : uris) {
        String name = "file";
        long size = -1;
        try (Cursor c = getContentResolver().query(u, null, null, null, null)) {
          if (c != null && c.moveToFirst()) {
            int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE);
            if (ni >= 0 && c.getString(ni) != null) name = c.getString(ni);
            if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
          }
        } catch (Exception ignored) {}
        String mime = getContentResolver().getType(u);
        try {
          JSONObject o = new JSONObject().put("name", name).put("mime", mime == null ? "" : mime);
          if (size > MAX_PICK) { out.put(o.put("error", "too big")); continue; }
          File f = new File(dir, java.util.UUID.randomUUID().toString());
          long total = 0;
          try (InputStream in = getContentResolver().openInputStream(u); OutputStream os = new FileOutputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
              total += n;
              if (total > MAX_PICK) break;
              os.write(buf, 0, n);
            }
          }
          if (total > MAX_PICK) { f.delete(); out.put(o.put("error", "too big")); continue; }
          out.put(o.put("path", f.getAbsolutePath()).put("size", total));
        } catch (Exception e) {
          Log.w("YapApp", "could not read picked file", e);
        }
      }
      deliverPicked(out);
    }).start();
  }

  private void deliverPicked(JSONArray list) {
    mainHandler.post(() -> {
      if (webView != null) webView.evaluateJavascript("window.__yapPicked && window.__yapPicked(" + list + ")", null);
    });
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
