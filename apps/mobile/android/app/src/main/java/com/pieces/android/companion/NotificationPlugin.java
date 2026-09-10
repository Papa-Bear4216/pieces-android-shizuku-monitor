package com.pieces.android.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuRemoteProcess;

/**
 * JS bridge for the notification listener (Part 1).
 *
 * Mirrors ShizukuMonitorPlugin's trust model: the privileged grant path
 * (enableViaShizuku) is gated on the same shizuku_toolkit_enabled flag, and
 * the capture master switch (setCaptureEnabled) is a separate explicit opt-in.
 */
@CapacitorPlugin(name = "NotificationCapture")
public class NotificationPlugin extends Plugin {

    static final String CAPTURE_ENABLED_KEY = "notification_capture_enabled";
    static final String CAPTURE_ALL_APPS_KEY = "notification_capture_all_apps";

    private static final String SERVICE_COMPONENT =
        "com.pieces.android.companion/com.pieces.android.companion.NotificationCaptureService";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        super.load();
        NotificationCaptureService.listener = (pkg, appLabel, title, text, postedAt) -> {
            JSObject data = new JSObject();
            data.put("package", pkg);
            data.put("appLabel", appLabel);
            data.put("title", title);
            data.put("text", text);
            data.put("postedAt", postedAt);
            notifyListeners("notification", data);
        };
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(AccessibilityPlugin.PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** Is our NotificationListenerService currently granted by the OS? */
    @PluginMethod
    public void isListenerEnabled(PluginCall call) {
        String flat = Settings.Secure.getString(
            getContext().getContentResolver(), "enabled_notification_listeners");
        boolean enabled = false;
        if (!TextUtils.isEmpty(flat)) {
            ComponentName me = new ComponentName(getContext(), NotificationCaptureService.class);
            for (String entry : flat.split(":")) {
                ComponentName cn = ComponentName.unflattenFromString(entry);
                if (cn != null && cn.equals(me)) { enabled = true; break; }
            }
        }
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    /** Master capture switch + optional "all apps" widening. */
    @PluginMethod
    public void setCaptureEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Must provide enabled boolean"); return; }
        SharedPreferences.Editor e = prefs().edit().putBoolean(CAPTURE_ENABLED_KEY, enabled);
        Boolean allApps = call.getBoolean("allApps");
        if (allApps != null) e.putBoolean(CAPTURE_ALL_APPS_KEY, allApps);
        e.apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    @PluginMethod
    public void getCaptureConfig(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", prefs().getBoolean(CAPTURE_ENABLED_KEY, false));
        ret.put("allApps", prefs().getBoolean(CAPTURE_ALL_APPS_KEY, false));
        call.resolve(ret);
    }

    /** Grant the listener via Shizuku, append-safe. */
    @PluginMethod
    public void enableViaShizuku(PluginCall call) {
        if (!prefs().getBoolean("shizuku_toolkit_enabled", false)) {
            call.reject("Shizuku toolkit is not enabled. Enable it in Setup first.");
            return;
        }
        if (!Shizuku.pingBinder()) {
            call.reject("Shizuku is not active. Start the Shizuku app daemon.");
            return;
        }
        if (Shizuku.checkSelfPermission() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Shizuku.requestPermission(0);
            call.reject("Shizuku permission requested. Please approve in the Shizuku app.");
            return;
        }
        executor.execute(() -> {
            try {
                // `cmd notification allow_listener` is the modern, append-safe
                // API (unlike settings put, which clobbers the whole list).
                runShell("cmd notification allow_listener " + SERVICE_COMPONENT);
                JSObject ret = new JSObject();
                ret.put("status", "granted");
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("Failed to grant notification listener: " + ex.getMessage());
            }
        });
    }

    /** Fallback: open the system settings screen for the user to toggle manually. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private String runShell(String command) throws Exception {
        ShizukuRemoteProcess process = Shizuku.newProcess(new String[]{"sh", "-c", command}, null, null);
        BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
        StringBuilder output = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) output.append(line).append("\n");
        return output.toString();
    }
}
