package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class PiecesAccessibilityService extends AccessibilityService {

    // A static buffer to hold the most recently extracted text blocks across the OS
    public static List<String> lastCapturedText = new ArrayList<>();
    public static String lastCapturedPackage = "";

    // Debounce settle time for passive mode: wait this long after the last
    // accessibility event before treating the screen as "settled" and
    // considering a push. Avoids firing on every keystroke/scroll.
    private static final long DEBOUNCE_MS = 2000;

    private final Handler debounceHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPush;
    private String lastPushedText = "";
    private String lastPushedPackage = "";

    // Set by AccessibilityPlugin when the JS layer wants passive-mode pushes
    // delivered as they're debounced, instead of only on-demand via
    // getActiveScreenText(). Null when nobody's listening (e.g. plugin not
    // yet initialized) — pushes are simply skipped, buffer still updates.
    public interface PassiveCaptureListener {
        void onCapture(String packageName, String text);
    }
    public static volatile PassiveCaptureListener passiveListener;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getSource() == null) return;

        String packageName = event.getPackageName() != null ? event.getPackageName().toString() : "";
        if (!isAllowed(packageName)) return;

        AccessibilityNodeInfo rootNode = event.getSource();
        List<String> extractedTexts = new ArrayList<>();
        try {
            extractText(rootNode, extractedTexts);
        } finally {
            rootNode.recycle();
        }

        if (extractedTexts.isEmpty()) return;

        lastCapturedPackage = packageName;
        lastCapturedText = extractedTexts;

        if (isPassiveModeEnabled()) {
            scheduleDebouncedPush(packageName, String.join("\n", extractedTexts));
        }
    }

    private void scheduleDebouncedPush(String packageName, String text) {
        if (pendingPush != null) debounceHandler.removeCallbacks(pendingPush);
        pendingPush = () -> {
            // Dedupe: skip if identical to the last thing we actually pushed,
            // so a static/unchanging screen doesn't repeat-fire every DEBOUNCE_MS.
            if (text.equals(lastPushedText) && packageName.equals(lastPushedPackage)) return;
            lastPushedText = text;
            lastPushedPackage = packageName;
            PassiveCaptureListener listener = passiveListener;
            if (listener != null) listener.onCapture(packageName, text);
        };
        debounceHandler.postDelayed(pendingPush, DEBOUNCE_MS);
    }

    private boolean isPassiveModeEnabled() {
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(AccessibilityPlugin.PASSIVE_MODE_KEY, false);
    }

    // Only capture from packages the user explicitly selected via the app picker
    // (AccessibilityPlugin.setAllowlist) — this service is system-wide by platform
    // design (any app can fire a window event), so this check is the only thing
    // standing between "capture text from whatever's on screen" and "capture text
    // from apps the user actually opted into."
    private boolean isAllowed(String packageName) {
        if (packageName.isEmpty()) return false;
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        Set<String> allowlist = prefs.getStringSet(AccessibilityPlugin.ALLOWLIST_KEY, new HashSet<>());
        return allowlist.contains(packageName);
    }

    private void extractText(AccessibilityNodeInfo node, List<String> texts) {
        if (node == null) return;

        if (node.getText() != null && node.getText().length() > 0) {
            texts.add(node.getText().toString());
        }
        if (node.getContentDescription() != null && node.getContentDescription().length() > 0) {
            texts.add(node.getContentDescription().toString());
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            extractText(child, texts);
            if (child != null) child.recycle();
        }
    }

    @Override
    public void onInterrupt() {
        // Required method, ignored for now
    }
}
