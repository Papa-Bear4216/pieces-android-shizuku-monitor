package com.pieces.android.companion;

import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuRemoteProcess;

@CapacitorPlugin(name = "ShizukuMonitor")
public class ShizukuMonitorPlugin extends Plugin {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Fixed set of preset diagnostic commands the WebView may trigger via executeCommand.
    // Enforced here, not just in the React UI, since a compromised/malicious WebView
    // context (XSS, rogue remote content) must not be able to run arbitrary shell.
    // The accessibility-service-enable flow is intentionally NOT in this list — it's
    // handled by the dedicated enableAccessibilityService() method below instead of
    // free-form command text, so its target service id can't be swapped by the caller.
    private static final Set<String> ALLOWED_COMMANDS = new HashSet<>(Arrays.asList(
        "dumpsys battery",
        "dumpsys cpuinfo",
        "dumpsys meminfo",
        "pm list packages -3",
        "ifconfig wlan0",
        "getprop ro.build.version.release"
    ));

    private static final String ACCESSIBILITY_SERVICE_ID =
        "com.pieces.android.companion/com.pieces.android.companion.PiecesAccessibilityService";

    // Mirrors AccessibilityPlugin's own prefs store — kept as one shared file so
    // both plugins' opt-in flags live in the same place the native side reads.
    private static final String TOOLKIT_ENABLED_KEY = "shizuku_toolkit_enabled";

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(AccessibilityPlugin.PREFS_NAME, android.content.Context.MODE_PRIVATE);
    }

    private boolean isToolkitEnabled() {
        return getPrefs().getBoolean(TOOLKIT_ENABLED_KEY, false);
    }

    // Mirrors the JS-side Capacitor Preferences flag (config.ts's
    // shizukuToolkitEnabled) into native SharedPreferences — previously the
    // toolkit's privileged methods were reachable from any WebView JS
    // regardless of whether the user had ever flipped the Setup toggle on.
    @PluginMethod
    public void setToolkitEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Must provide enabled boolean");
            return;
        }
        getPrefs().edit().putBoolean(TOOLKIT_ENABLED_KEY, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    // Reports whether Shizuku is actually reachable and permission-granted —
    // used by App.tsx on launch to decide whether to show the "offline"
    // banner. Previously App.tsx called a checkPermission() method that
    // didn't exist here at all, so this call always failed and the banner
    // showed regardless of Shizuku's real state.
    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = Shizuku.pingBinder()
            && Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED;
        ret.put("status", granted ? "granted" : "not_granted");
        call.resolve(ret);
    }

    private String runShell(String command) throws Exception {
        ShizukuRemoteProcess process = Shizuku.newProcess(new String[]{"sh", "-c", command}, null, null);
        BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
        StringBuilder output = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            output.append(line).append("\n");
        }
        return output.toString();
    }

    @PluginMethod
    public void executeCommand(PluginCall call) {
        if (!isToolkitEnabled()) {
            call.reject("Shizuku toolkit is not enabled. Enable it in Setup first.");
            return;
        }

        String command = call.getString("command");
        if (command == null || command.isEmpty()) {
            call.reject("Must provide a command string");
            return;
        }

        if (!ALLOWED_COMMANDS.contains(command)) {
            call.reject("Command not in allowlist");
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
                JSObject ret = new JSObject();
                ret.put("output", runShell(command));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Privileged execution failed: " + e.getMessage());
            }
        });
    }

    // Enables the Pieces Accessibility Service by appending its component id to the
    // existing enabled_accessibility_services list (so it never clobbers other
    // accessibility services the user already has on), then flips the master switch.
    // Only callable after the user has explicitly opted in via the Setup screen —
    // that gate lives in the React layer (App.tsx), same as the rest of this plugin's
    // trust model: Shizuku itself already requires a manual one-time grant in its own
    // app, so this is a second, narrower privileged action layered on top of that.
    @PluginMethod
    public void enableAccessibilityService(PluginCall call) {
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
                String current = runShell("settings get secure enabled_accessibility_services").trim();
                if (current.equals("null")) current = "";

                if (!current.contains(ACCESSIBILITY_SERVICE_ID)) {
                    String updated = current.isEmpty()
                        ? ACCESSIBILITY_SERVICE_ID
                        : current + ":" + ACCESSIBILITY_SERVICE_ID;
                    // Values are shell-quoted since they're existing OS-authored settings
                    // content (colon-joined component ids), not arbitrary caller input.
                    runShell("settings put secure enabled_accessibility_services '" + updated + "'");
                    runShell("settings put secure accessibility_enabled 1");
                }

                JSObject ret = new JSObject();
                ret.put("status", "enabled");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to enable accessibility service: " + e.getMessage());
            }
        });
    }
}
