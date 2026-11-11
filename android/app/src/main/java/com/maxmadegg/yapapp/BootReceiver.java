package com.maxmadegg.yapapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * After a reboot (or a self-update replacing the app) start the service so it
 * rejoins the remembered room without the user opening the app. These
 * broadcasts are exempt from Android 12's background foreground-service limits.
 * The service gives up quietly if there's no fresh remembered login.
 */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String a = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
    try {
      context.startForegroundService(new Intent(context, YapService.class).setAction(YapService.ACTION_AUTOJOIN));
    } catch (Exception e) {
      Log.w("YapApp", "could not auto-start service", e);
    }
  }
}
