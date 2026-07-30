package com.pieces.android.companion;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@CapacitorPlugin(name = "AccessibilityScanner")
public class AccessibilityPlugin extends Plugin {

    static final String PREFS_NAME = "pieces_accessibility_prefs";
    static final String ALLOWLIST_KEY = "captured_package_allowlist";
    static final String PASSIVE_MODE_KEY = "passive_mode_enabled";

    @Override
    public void load() {
        super.load();
        // Bridges the accessibility service's debounced captures to JS via a
        // Capacitor event. Registered once per plugin instance; the service
        // only calls this if passive mode is on (checked on its side too).
        PiecesAccessibilityService.passiveListener = (packageName, text) -> {
            JSObject data = new JSObject();
            data.put("package", packageName);
            data.put("textNodes", text);
            notifyListeners("passiveCapture", data);
        };
    }

    // Excluded from the app picker outright — never selectable, regardless of what the
    // user picks. Matched by package-name prefix, not exact string, since these vendors
    // ship many package ids (e.g. multiple Google Pay variants, regional banking apps).
    private static final List<String> EXCLUDED_PREFIXES = Arrays.asList(
        "com.android.vending",      // Play Store account/payment flows
        "com.google.android.apps.walletnfcrel", // Google Wallet
        "com.google.android.apps.nbu.paisa",    // Google Pay
        "com.paypal",
        "com.venmo",
        "com.squareup.cash",
        "com.lastpass",
        "com.agilebits.onepassword", // 1Password
        "com.bitwarden",
        "com.dashlane",
        "com.keepersecurity",
        "com.nordpass",
        "com.chase",
        "com.bankofamerica",
        "com.wellsfargo",
        "com.citi",
        "com.capitalone",
        "com.usaa",
        // Messaging / SMS / calling
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.whatsapp",
        "com.facebook.orca",       // Messenger
        "org.telegram.messenger",
        "org.thoughtcrime.securesms", // Signal
        "com.discord",
        "com.google.android.talk", // Hangouts/Chat
        "com.skype.raider",
        "com.google.android.apps.tachyon", // Google Meet/Duo
        "com.samsung.android.incallui",
        "com.android.mms",
        "com.android.phone",
        // Email
        "com.google.android.gm",   // Gmail
        "com.microsoft.office.outlook",
        "com.samsung.android.email.provider",
        "com.yahoo.mobile.client.android.mail",
        // Social
        "com.facebook.katana",
        "com.instagram.android",
        "com.twitter.android",
        "com.zhiliaoapp.musically", // TikTok
        "com.snapchat.android",
        "com.reddit.frontpage",
        "com.linkedin.android",
        "com.pinterest",
        "com.tumblr"
    );

    private boolean isExcluded(String packageName) {
        for (String prefix : EXCLUDED_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        return false;
    }

    @PluginMethod
    public void listInstalledApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);

        JSArray result = new JSArray();
        for (ApplicationInfo app : apps) {
            if (isExcluded(app.packageName)) continue;
            JSObject entry = new JSObject();
            entry.put("packageName", app.packageName);
            entry.put("label", pm.getApplicationLabel(app).toString());
            result.put(entry);
        }

        JSObject ret = new JSObject();
        ret.put("apps", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void getAllowlist(PluginCall call) {
        Set<String> allowlist = getPrefs().getStringSet(ALLOWLIST_KEY, new HashSet<>());
        JSArray result = new JSArray();
        for (String pkg : allowlist) result.put(pkg);
        JSObject ret = new JSObject();
        ret.put("packages", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void setAllowlist(PluginCall call) {
        JSArray packages = call.getArray("packages");
        if (packages == null) {
            call.reject("Must provide a packages array");
            return;
        }

        Set<String> allowlist = new HashSet<>();
        try {
            List<Object> list = packages.toList();
            for (Object pkg : list) {
                String name = String.valueOf(pkg);
                // Defense in depth: even if the caller tries to slip an excluded
                // package into the allowlist directly, it's dropped here too.
                if (!isExcluded(name)) allowlist.add(name);
            }
        } catch (Exception e) {
            call.reject("Invalid packages array", e);
            return;
        }

        getPrefs().edit().putStringSet(ALLOWLIST_KEY, allowlist).apply();

        JSObject ret = new JSObject();
        ret.put("status", "saved");
        ret.put("count", allowlist.size());
        call.resolve(ret);
    }

    @PluginMethod
    public void getPassiveModeEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", getPrefs().getBoolean(PASSIVE_MODE_KEY, false));
        call.resolve(ret);
    }

    // Passive mode has its own gate on top of the toolkit opt-in and the app
    // allowlist — enabling it means captured text is pushed automatically
    // (debounced/deduped in PiecesAccessibilityService) instead of only on a
    // button tap. The React layer requires a typed confirmation before
    // calling this, but this method itself has no additional precondition
    // beyond that call — the allowlist emptiness check is enforced in React
    // since an empty allowlist just means passive mode has nothing to send.
    @PluginMethod
    public void setPassiveModeEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Must provide enabled boolean");
            return;
        }
        getPrefs().edit().putBoolean(PASSIVE_MODE_KEY, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        call.resolve(ret);
    }

    // Standalone path to enabling the Accessibility Service — no Shizuku
    // required. Opens Android's own Accessibility Settings screen; the user
    // finds "Pieces Android Companion" in the list and flips it on manually,
    // same as enabling a screen reader or password-manager autofill service.
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void isAccessibilityServiceEnabled(PluginCall call) {
        String enabledServices = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        String target = getContext().getPackageName() + "/" + PiecesAccessibilityService.class.getName();
        boolean enabled = !TextUtils.isEmpty(enabledServices) && enabledServices.contains(target);

        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void getActiveScreenText(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("package", PiecesAccessibilityService.lastCapturedPackage);
            ret.put("textNodes", String.join("\n", PiecesAccessibilityService.lastCapturedText));

            if (PiecesAccessibilityService.lastCapturedText.isEmpty()) {
                ret.put("status", "No text captured yet — service not enabled, or no allowlisted app has been in the foreground");
            } else {
                ret.put("status", "success");
            }

            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to retrieve accessibility buffer", e);
        }
    }

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE);
    }
}
