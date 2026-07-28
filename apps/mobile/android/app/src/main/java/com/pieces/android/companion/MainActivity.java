package com.pieces.android.companion;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(ShizukuMonitorPlugin.class);
        registerPlugin(AccessibilityPlugin.class);
    }
}
