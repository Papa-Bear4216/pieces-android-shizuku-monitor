package com.pieces.android.companion;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Process;
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
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "AccessibilityScanner")
public class AccessibilityPlugin extends Plugin {

    static final String PREFS_NAME = "pieces_accessibility_prefs";
    static final String ALLOWLIST_KEY = "captured_package_allowlist";
    static final String PASSIVE_MODE_KEY = "passive_mode_enabled";
    static final String SCREEN_CONTEXT_ENABLED_KEY = "screen_context_enabled";

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

    // Excluded from the app picker for a different reason than EXCLUDED_PREFIXES —
    // not privacy-sensitive, just useless signal. Keyboards emit one node per
    // keypress, system UI/launcher churn constantly with clock/battery/notification
    // text, and OEM/carrier services have no user-facing screen worth capturing.
    // Keeping this list separate from the privacy one lets each be audited for its
    // own reason independently.
    private static final List<String> EXCLUDED_NOISE_PREFIXES = Arrays.asList(
        // Keyboards / input methods
        "com.samsung.android.honeyboard",
        "com.google.android.inputmethod",
        "com.touchtype.swiftkey",
        "com.google.android.googlequicksearchbox", // includes Gboard voice/assistant surface
        // System UI / launcher / shell chrome
        "com.android.systemui",
        "com.sec.android.app.launcher",
        "com.google.android.apps.nexuslauncher",
        "com.android.settings",
        "com.samsung.android.app.settings",
        "com.android.launcher3",
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        // OEM/carrier background services with no meaningful on-screen text
        "com.samsung.android.mdecservice",
        "com.samsung.android.dqagent",
        "com.samsung.android.game.gametools",
        "com.wssyncmldm",             // carrier device-management
        "com.sec.android.diagmonagent",
        "com.samsung.android.sm",     // Samsung Device Care
        "com.android.providers",      // content providers, no UI
        "com.google.android.gms",     // Play Services background surface
        "com.google.android.packageinstaller",
        "com.android.packageinstaller"
    );

    // static + package-visible so PiecesAccessibilityService.isAllowed can
    // enforce this same denylist independently of the allowlist it reads
    // from SharedPreferences — that allowlist has no built-in cross-check
    // against these lists (it's user-editable, opt-in state, not a fixed
    // ruleset), so without this call, a sensitive/noise package that ever
    // ends up in the saved allowlist (a picker bug, a manually-edited prefs
    // file, an app id reused by a different vendor over time) would be
    // captured with nothing to stop it.
    static boolean isExcluded(String packageName) {
        for (String prefix : EXCLUDED_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        for (String prefix : EXCLUDED_NOISE_PREFIXES) {
            if (packageName.startsWith(prefix)) return true;
        }
        return false;
    }

    // ApplicationInfo.CATEGORY_* constants (API 26+) — getCategoryTitle() needs
    // a Resources handle we don't have per-app here, so map to a fixed label
    // set ourselves. CATEGORY_UNDEFINED (-1) and anything unmapped falls into
    // "Uncategorized" in the JS-side grouping, not here — this method only
    // reports the raw label, grouping is a picker-UI concern.
    private static String categoryLabel(int category) {
        switch (category) {
            case ApplicationInfo.CATEGORY_GAME: return "Game";
            case ApplicationInfo.CATEGORY_AUDIO: return "Audio";
            case ApplicationInfo.CATEGORY_VIDEO: return "Video";
            case ApplicationInfo.CATEGORY_IMAGE: return "Image";
            case ApplicationInfo.CATEGORY_SOCIAL: return "Social";
            case ApplicationInfo.CATEGORY_NEWS: return "News";
            case ApplicationInfo.CATEGORY_MAPS: return "Maps";
            case ApplicationInfo.CATEGORY_PRODUCTIVITY: return "Productivity";
            case ApplicationInfo.CATEGORY_ACCESSIBILITY: return "Accessibility";
            default: return "Uncategorized";
        }
    }

    @PluginMethod
    public void listInstalledApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);

        JSArray result = new JSArray();
        for (ApplicationInfo app : apps) {
            if (isExcluded(app.packageName)) continue;
            boolean isSystem = (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0
                || (app.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
            JSObject entry = new JSObject();
            entry.put("packageName", app.packageName);
            entry.put("label", pm.getApplicationLabel(app).toString());
            entry.put("isSystemApp", isSystem);
            entry.put("category", categoryLabel(app.category));
            result.put(entry);
        }

        JSObject ret = new JSObject();
        ret.put("apps", result);
        call.resolve(ret);
    }

    // Usage Access is a special AppOps permission — no manifest runtime-permission
    // dialog exists for it. The user must grant it manually via the Settings
    // screen this opens, same UX shape as openAccessibilitySettings() above.
    @PluginMethod
    public void isUsageAccessGranted(PluginCall call) {
        AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(android.content.Context.APP_OPS_SERVICE);
        int mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            getContext().getPackageName()
        );
        JSObject ret = new JSObject();
        ret.put("granted", mode == AppOpsManager.MODE_ALLOWED);
        call.resolve(ret);
    }

    @PluginMethod
    public void openUsageAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    // Suggestion source for the picker's "Recently used" section — never
    // capture-gating on its own. Results still only affect the allowlist via
    // the same setAllowlist() opt-in path the picker already uses; this just
    // pre-populates what gets checked by default, all user-editable before save.
    // Below this, a package is treated as incidentally foregrounded (a
    // settings screen passed through, a permission dialog, a notification-
    // shade tap) rather than actually used. On a real device with 500+
    // installed packages, even genuine foreground-only time (not background
    // service time — getTotalTimeInForeground() already excludes that)
    // accumulates across enough apps that an any-nonzero filter alone let
    // through 520 packages. This threshold is the fix, not a background-vs-
    // foreground distinction, which UsageStats already handles correctly.
    private static final long MIN_FOREGROUND_MS_FOR_RECENT = TimeUnit.SECONDS.toMillis(60);

    @PluginMethod
    public void getRecentlyUsedPackages(PluginCall call) {
        Integer days = call.getInt("days", 7);
        UsageStatsManager usm = (UsageStatsManager) getContext().getSystemService(android.content.Context.USAGE_STATS_SERVICE);
        if (usm == null) {
            call.reject("UsageStatsManager unavailable");
            return;
        }

        long end = System.currentTimeMillis();
        long start = end - TimeUnit.DAYS.toMillis(days);
        // INTERVAL_DAILY returns one entry per package PER DAY BUCKET, not one
        // total per package — sum across buckets before thresholding, or a
        // package with a few seconds each day over 7 days looks like several
        // separate sub-threshold blips instead of the ~minutes it actually adds to.
        List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);

        java.util.Map<String, Long> totalForegroundMs = new java.util.HashMap<>();
        if (stats != null) {
            for (UsageStats stat : stats) {
                String pkg = stat.getPackageName();
                if (pkg == null || isExcluded(pkg)) continue;
                long existing = totalForegroundMs.containsKey(pkg) ? totalForegroundMs.get(pkg) : 0L;
                totalForegroundMs.put(pkg, existing + stat.getTotalTimeInForeground());
            }
        }

        JSArray result = new JSArray();
        for (java.util.Map.Entry<String, Long> entry : totalForegroundMs.entrySet()) {
            if (entry.getValue() >= MIN_FOREGROUND_MS_FOR_RECENT) {
                result.put(entry.getKey());
            }
        }

        JSObject ret = new JSObject();
        ret.put("packages", result);
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

    // Mirrors the JS-side Capacitor Preferences flag (config.ts's
    // screenContextEnabled) into the native SharedPreferences store the
    // accessibility service actually reads (PiecesAccessibilityService.isAllowed
    // and the passive-mode gate both check this) — previously the native layer
    // never saw this flag at all, so toggling it off in Setup didn't stop capture.
    @PluginMethod
    public void setScreenContextEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Must provide enabled boolean");
            return;
        }
        getPrefs().edit().putBoolean(SCREEN_CONTEXT_ENABLED_KEY, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
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
