package com.maxmadegg.yapapp;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update from the rolling "latest" GitHub release (built by CI):
 *   android-latest.json = { versionCode, versionName, url }
 * If it's newer than us, download the APK to the cache, sanity-check it (our
 * package, newer version) and report it ready. Installing goes through
 * PackageInstaller; Android always asks the user to confirm, and only accepts
 * an APK signed with the same key as the installed app.
 */
class Updater {
  private static final String TAG = "YapApp";
  static final String FEED = "https://github.com/MaxMadeGG/YapApp/releases/download/latest/android-latest.json";
  private static final long CHECK_EVERY_MS = 4 * 3600 * 1000L;

  interface Ready { void onReady(String versionName); }

  private final Context ctx;
  private final File apk;
  private String readyVersion;

  Updater(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.apk = new File(this.ctx.getCacheDir(), "update.apk");
  }

  // Debug builds only: files/update-feed.txt overrides the feed URL (testing).
  private String testFeed() {
    if ((ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) return null;
    File f = new File(ctx.getFilesDir(), "update-feed.txt");
    if (!f.exists()) return null;
    try (InputStream in = new FileInputStream(f)) {
      java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
      copy(in, b);
      return b.toString("UTF-8").trim();
    } catch (Exception e) {
      return null;
    }
  }

  /** Check (at most every few hours unless forced) on a background thread. */
  void checkAsync(boolean force, Ready ready) {
    if (testFeed() != null) force = true;
    SharedPreferences prefs = ctx.getSharedPreferences("yapapp", Context.MODE_PRIVATE);
    long last = prefs.getLong("lastUpdateCheck", 0);
    if (!force && System.currentTimeMillis() - last < CHECK_EVERY_MS) {
      if (readyVersion != null) ready.onReady(readyVersion);
      return;
    }
    prefs.edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply();
    new Thread(() -> {
      try {
        String v = check();
        if (v != null) { readyVersion = v; ready.onReady(v); }
      } catch (Exception e) {
        Log.i(TAG, "update check failed: " + e);
      }
    }, "yapapp-update").start();
  }

  private String check() throws Exception {
    long current = currentVersionCode();
    String feedUrl = testFeed() != null ? testFeed() : FEED;
    JSONObject feed = new JSONObject(new String(get(feedUrl, null), "UTF-8"));
    long latest = feed.getLong("versionCode");
    if (latest <= current) { apk.delete(); return null; }

    // Already downloaded this version?
    if (!isValidUpdate(latest)) {
      get(feed.getString("url"), apk);
      if (!isValidUpdate(latest)) { apk.delete(); throw new Exception("downloaded APK failed checks"); }
    }
    return feed.optString("versionName", String.valueOf(latest));
  }

  private boolean isValidUpdate(long expectedCode) {
    if (!apk.exists()) return false;
    PackageInfo info = ctx.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
    return info != null && ctx.getPackageName().equals(info.packageName)
      && info.getLongVersionCode() == expectedCode && expectedCode > currentVersionCode();
  }

  private long currentVersionCode() {
    try {
      return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).getLongVersionCode();
    } catch (PackageManager.NameNotFoundException e) {
      return 0;
    }
  }

  /** GET url (following redirects, e.g. GitHub -> CDN) into a file, or return the bytes. */
  private static byte[] get(String url, File out) throws Exception {
    for (int hops = 0; hops < 5; hops++) {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setInstanceFollowRedirects(false);
      c.setConnectTimeout(15000);
      c.setReadTimeout(60000);
      int code = c.getResponseCode();
      if (code >= 300 && code < 400) { url = new URL(new URL(url), c.getHeaderField("Location")).toString(); c.disconnect(); continue; }
      if (code != 200) { c.disconnect(); throw new Exception("HTTP " + code + " for " + url); }
      try (InputStream in = c.getInputStream()) {
        if (out == null) {
          java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
          copy(in, b);
          return b.toByteArray();
        }
        File tmp = new File(out.getPath() + ".part");
        try (OutputStream o = new FileOutputStream(tmp)) { copy(in, o); }
        if (!tmp.renameTo(out)) throw new Exception("rename failed");
        return null;
      } finally {
        c.disconnect();
      }
    }
    throw new Exception("too many redirects");
  }

  private static void copy(InputStream in, OutputStream out) throws Exception {
    byte[] buf = new byte[64 * 1024];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
  }

  /** Hand the downloaded APK to the system installer (user confirms). */
  void install() {
    new Thread(() -> {
      try {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session session = pi.openSession(id)) {
          try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("yapapp.apk", 0, apk.length())) {
            copy(in, out);
            session.fsync(out);
          }
          Intent cb = new Intent(ctx, InstallResult.class);
          PendingIntent pending = PendingIntent.getBroadcast(ctx, id, cb, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
          session.commit(pending.getIntentSender());
        }
      } catch (Exception e) {
        Log.e(TAG, "install failed", e);
      }
    }, "yapapp-install").start();
  }

  /** Receives the installer's status; shows the system confirmation dialog. */
  public static class InstallResult extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
      int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
        if (confirm != null) {
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          context.startActivity(confirm);
        }
      } else if (status != PackageInstaller.STATUS_SUCCESS) {
        Log.w(TAG, "update install status " + status + ": " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
      }
    }
  }
}
