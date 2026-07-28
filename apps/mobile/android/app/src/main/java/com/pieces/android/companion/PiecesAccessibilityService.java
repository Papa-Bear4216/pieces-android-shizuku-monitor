package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;

public class PiecesAccessibilityService extends AccessibilityService {

    // A static buffer to hold the most recently extracted text blocks across the OS
    public static List<String> lastCapturedText = new ArrayList<>();
    public static String lastCapturedPackage = "";

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getSource() == null) return;

        AccessibilityNodeInfo rootNode = event.getSource();
        List<String> extractedTexts = new ArrayList<>();
        extractText(rootNode, extractedTexts);

        if (!extractedTexts.isEmpty()) {
            lastCapturedPackage = event.getPackageName() != null ? event.getPackageName().toString() : "unknown";
            lastCapturedText = extractedTexts;
        }
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
