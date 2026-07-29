package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
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

        if (!extractedTexts.isEmpty()) {
            lastCapturedPackage = packageName;
            lastCapturedText = extractedTexts;
        }
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
