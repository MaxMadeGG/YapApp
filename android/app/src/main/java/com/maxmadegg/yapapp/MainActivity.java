package com.maxmadegg.yapapp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

import to.holepunch.bare.kit.IPC;
import to.holepunch.bare.kit.Worklet;

/**
 * Hosts the shared chat UI (assets/www/index.html) in a WebView and runs the
 * chat core (assets/app.bundle = core.js + Hyperswarm) in a Bare Kit worklet.
 *
 * WebView  --YapNative.post(line)-->  IPC thread  --BareKit.IPC-->  worklet
 * WebView  <--window.__yapRecv(line)--  main thread  <--  IPC thread  <--  worklet
 * Lines are newline-delimited JSON (see app/src/main/js/app.js).
 */
public class MainActivity extends Activity {
  private static final String TAG = "YapApp";

  private WebView webView;
  private Worklet worklet;
  private IPC ipc;
  private HandlerThread ipcThread;
  private Handler ipcHandler;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());

  // IPC-thread state
  private final ByteArrayOutputStream readBuf = new ByteArrayOutputStream();
  private final ArrayDeque<ByteBuffer> writeQueue = new ArrayDeque<>();

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

    startWorklet();
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

  private void startWorklet() {
    ipcThread = new HandlerThread("yapapp-ipc");
    ipcThread.start();
    ipcHandler = new Handler(ipcThread.getLooper());
    final String dataDir = getFilesDir().getAbsolutePath();

    ipcHandler.post(() -> {
      try {
        worklet = new Worklet(null);
        worklet.start("/app.bundle", getAssets().open("app.bundle"), new String[] { dataDir });
        ipc = new IPC(worklet);
        ipc.readable(this::onReadable);
        flushWrites();
      } catch (Exception e) {
        Log.e(TAG, "failed to start worklet", e);
      }
    });
  }

  // IPC thread: drain everything available, forward complete lines to the UI.
  private void onReadable() {
    ByteBuffer data;
    while ((data = ipc.read()) != null) {
      if (data.limit() == 0) { ipc.readable(null); return; } // worklet closed its end
      byte[] bytes = new byte[data.remaining()];
      data.get(bytes);
      for (byte by : bytes) {
        if (by == '\n') {
          String line = new String(readBuf.toByteArray(), StandardCharsets.UTF_8);
          readBuf.reset();
          deliver(line);
        } else {
          readBuf.write(by);
        }
      }
    }
  }

  private void deliver(String line) {
    final String js = "window.__yapRecv && window.__yapRecv(" + JSONObject.quote(line) + ")";
    mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(js, null); });
  }

  // IPC thread: write queued lines, waiting for writable() on backpressure.
  private void flushWrites() {
    if (ipc == null) return;
    while (!writeQueue.isEmpty()) {
      ByteBuffer head = writeQueue.peek();
      int n = ipc.write(head);
      if (n < 0) { Log.e(TAG, "IPC write failed: " + n); writeQueue.clear(); break; }
      if (n < head.remaining()) {
        head.position(head.position() + n);
        writeQueue.poll();
        writeQueue.addFirst(head.slice());
        ipc.writable(this::flushWrites);
        return;
      }
      writeQueue.poll();
    }
    ipc.writable(null);
  }

  private void enqueue(String line) {
    byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
    ByteBuffer buf = ByteBuffer.allocateDirect(bytes.length);
    buf.put(bytes);
    buf.flip();
    ipcHandler.post(() -> { writeQueue.add(buf); flushWrites(); });
  }

  /** Exposed to the page as window.YapNative (see assets/www/bridge.js). */
  private class Bridge {
    @JavascriptInterface
    public void post(String line) { enqueue(line); }

    @JavascriptInterface
    public void copy(String text) {
      ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
      cm.setPrimaryClip(ClipData.newPlainText("YapApp invite", text));
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

  @Override
  protected void onPause() {
    super.onPause();
    if (ipcHandler != null) ipcHandler.post(() -> { if (worklet != null) worklet.suspend(); });
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (ipcHandler != null) ipcHandler.post(() -> { if (worklet != null) worklet.resume(); });
  }

  @Override
  protected void onDestroy() {
    if (ipcHandler != null) {
      ipcHandler.post(() -> {
        try { if (ipc != null) ipc.close(); } catch (Exception ignored) {}
        if (worklet != null) worklet.terminate();
        ipc = null;
        worklet = null;
      });
      ipcThread.quitSafely();
    }
    if (webView != null) { webView.destroy(); webView = null; }
    super.onDestroy();
  }
}
