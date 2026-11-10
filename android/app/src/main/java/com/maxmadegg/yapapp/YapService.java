package com.maxmadegg.yapapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

import to.holepunch.bare.kit.IPC;
import to.holepunch.bare.kit.Worklet;

/**
 * Owns the Bare worklet (chat core + Hyperswarm) so the chat stays connected
 * when the UI is closed. While in a room it runs as a foreground service with a
 * "Connected to #room" notification, and posts a notification for every
 * message from someone else while the UI isn't on screen.
 *
 * The activity binds to it, sends request lines with post() and receives
 * every line from the worklet through its Listener.
 */
public class YapService extends Service {
  private static final String TAG = "YapApp";
  static final String CH_CONN = "connection";
  static final String CH_MSG = "messages";
  static final int NOTIF_CONN = 1;
  static final int NOTIF_MSG = 2;
  static final String ACTION_DISCONNECT = "com.maxmadegg.yapapp.DISCONNECT";

  interface Listener { void onLine(String line); }

  private Worklet worklet;
  private IPC ipc;
  private HandlerThread ipcThread;
  private Handler ipcHandler;
  private final ByteArrayOutputStream readBuf = new ByteArrayOutputStream();
  private final ArrayDeque<ByteBuffer> writeQueue = new ArrayDeque<>();

  // Touched only on the IPC thread.
  private volatile Listener listener;
  private volatile boolean uiVisible;
  private boolean foreground;
  private String myName, roomName;
  private int peerCount;
  private final List<Notification.MessagingStyle.Message> unread = new ArrayList<>();
  private int serviceRequestId = -1;

  class LocalBinder extends Binder { YapService service() { return YapService.this; } }
  private final IBinder binder = new LocalBinder();

  @Override
  public void onCreate() {
    super.onCreate();
    createChannels();
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

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_DISCONNECT.equals(intent.getAction())) {
      // "Disconnect" button on the notification: leave the room and stop.
      ipcHandler.post(() -> {
        writeLine("{\"id\":" + (serviceRequestId--) + ",\"method\":\"leave\",\"args\":[]}");
        Listener l = listener;
        if (l != null) l.onLine("{\"event\":\"system\",\"data\":\"Disconnected from the notification\"}");
      });
    }
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) { return binder; }

  @Override
  public boolean onUnbind(Intent intent) {
    listener = null;
    uiVisible = false;
    // Not in a room and nobody looking: nothing to keep alive.
    ipcHandler.post(() -> { if (roomName == null) stopSelf(); });
    return true;
  }

  @Override
  public void onRebind(Intent intent) { }

  @Override
  public void onDestroy() {
    ipcHandler.post(() -> {
      try { if (ipc != null) ipc.close(); } catch (Exception ignored) {}
      if (worklet != null) worklet.terminate();
      ipc = null;
      worklet = null;
    });
    ipcThread.quitSafely();
    super.onDestroy();
  }

  // ---- API for the activity ------------------------------------------------

  void setListener(Listener l) { listener = l; }

  void setUiVisible(boolean visible) {
    uiVisible = visible;
    if (visible) {
      ipcHandler.post(() -> {
        unread.clear();
        getSystemService(NotificationManager.class).cancel(NOTIF_MSG);
      });
    }
  }

  void post(String line) { ipcHandler.post(() -> writeLine(line)); }

  // ---- Worklet IPC (IPC thread) ---------------------------------------------

  private void onReadable() {
    ByteBuffer data;
    while ((data = ipc.read()) != null) {
      if (data.limit() == 0) { ipc.readable(null); return; }
      byte[] bytes = new byte[data.remaining()];
      data.get(bytes);
      for (byte by : bytes) {
        if (by == '\n') {
          String line = new String(readBuf.toByteArray(), StandardCharsets.UTF_8);
          readBuf.reset();
          handleLine(line);
        } else {
          readBuf.write(by);
        }
      }
    }
  }

  private void handleLine(String line) {
    try {
      JSONObject msg = new JSONObject(line);
      String event = msg.optString("event", "");
      if (event.equals("status")) onStatus(msg.getJSONObject("data"));
      else if (event.equals("message")) onMessage(msg.getJSONObject("data"));
    } catch (Exception e) {
      Log.w(TAG, "bad line from worklet", e);
    }
    Listener l = listener;
    if (l != null) l.onLine(line);
  }

  private void writeLine(String line) {
    byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
    ByteBuffer buf = ByteBuffer.allocateDirect(bytes.length);
    buf.put(bytes);
    buf.flip();
    writeQueue.add(buf);
    flushWrites();
  }

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

  // ---- Notifications (IPC thread) -------------------------------------------

  private void onStatus(JSONObject s) {
    myName = s.isNull("name") ? null : s.optString("name");
    roomName = s.isNull("room") ? null : s.optString("room");
    peerCount = s.optInt("peers", 0);
    if (roomName != null) {
      Notification n = connectionNotification();
      if (!foreground) {
        if (Build.VERSION.SDK_INT >= 34) {
          startForeground(NOTIF_CONN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
          startForeground(NOTIF_CONN, n);
        }
        foreground = true;
      } else {
        getSystemService(NotificationManager.class).notify(NOTIF_CONN, n);
      }
    } else if (foreground) {
      stopForeground(STOP_FOREGROUND_REMOVE);
      foreground = false;
      unread.clear();
      getSystemService(NotificationManager.class).cancel(NOTIF_MSG);
      if (listener == null) stopSelf();
    }
  }

  private void onMessage(JSONObject m) {
    String from = m.optString("name", "?");
    if (uiVisible || from.equals(myName)) return;
    Person sender = new Person.Builder().setName(from).build();
    unread.add(new Notification.MessagingStyle.Message(m.optString("text", ""), m.optLong("ts", System.currentTimeMillis()), sender));
    while (unread.size() > 25) unread.remove(0);

    Notification.MessagingStyle style = new Notification.MessagingStyle(new Person.Builder().setName(myName == null ? "You" : myName).build());
    if (roomName != null) style.setConversationTitle("#" + roomName).setGroupConversation(true);
    for (Notification.MessagingStyle.Message msg : unread) style.addMessage(msg);

    Notification n = new Notification.Builder(this, CH_MSG)
      .setSmallIcon(R.drawable.ic_notification)
      .setStyle(style)
      .setContentIntent(openAppIntent())
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .build();
    getSystemService(NotificationManager.class).notify(NOTIF_MSG, n);
  }

  private Notification connectionNotification() {
    PendingIntent disconnect = PendingIntent.getService(this, 1,
      new Intent(this, YapService.class).setAction(ACTION_DISCONNECT),
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    String online = peerCount == 0 ? "waiting for others" : peerCount + " online";
    return new Notification.Builder(this, CH_CONN)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Connected to #" + roomName)
      .setContentText(online)
      .setContentIntent(openAppIntent())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(new Notification.Action.Builder(null, "Disconnect", disconnect).build())
      .build();
  }

  private PendingIntent openAppIntent() {
    Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private void createChannels() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel conn = new NotificationChannel(CH_CONN, "Connection", NotificationManager.IMPORTANCE_LOW);
    conn.setDescription("Shows that YapApp is connected to a room");
    conn.setShowBadge(false);
    NotificationChannel msgs = new NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH);
    msgs.setDescription("New chat messages");
    nm.createNotificationChannel(conn);
    nm.createNotificationChannel(msgs);
  }
}
