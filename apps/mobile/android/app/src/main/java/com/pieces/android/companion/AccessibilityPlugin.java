package com.pieces.android.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AccessibilityScanner")
public class AccessibilityPlugin extends Plugin {

    @PluginMethod
    public void getActiveScreenText(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("package", PiecesAccessibilityService.lastCapturedPackage);
            ret.put("textNodes", String.join("\n", PiecesAccessibilityService.lastCapturedText));
            
            if (PiecesAccessibilityService.lastCapturedText.isEmpty()) {
                ret.put("status", "No text captured yet, or service not enabled in Android Settings");
            } else {
                ret.put("status", "success");
            }
            
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to retrieve accessibility buffer", e);
        }
    }
}
