package com.pieces.android.companion;

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

@CapacitorPlugin(name = "ShizukuMonitor")
public class ShizukuMonitorPlugin extends Plugin {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getMetrics(PluginCall call) {
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
                // Escalate to UID 2000 via Shizuku Binder IPC
                ShizukuRemoteProcess process = Shizuku.newProcess(new String[]{"sh", "-c", "dumpsys meminfo && top -n 1 -m 5"}, null, null);
                BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                
                StringBuilder output = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
                
                process.waitFor();
                
                JSObject ret = new JSObject();
                ret.put("metrics", output.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Privileged execution failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void executeCommand(PluginCall call) {
        String command = call.getString("command");
        if (command == null || command.isEmpty()) {
            call.reject("Must provide a command string");
            return;
        }

        if (Shizuku.checkSelfPermission() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Shizuku.requestPermission(0);
            call.reject("Shizuku permission requested. Please approve in the Shizuku app.");
            return;
        }

        if (!Shizuku.pingBinder()) {
            call.reject("Shizuku is not active. Start the Shizuku app daemon.");
            return;
        }

        executor.execute(() -> {
            try {
                ShizukuRemoteProcess process = Shizuku.newProcess(new String[]{"sh", "-c", command}, null, null);
                BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                
                StringBuilder output = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
                
                JSObject ret = new JSObject();
                ret.put("output", output.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Privileged execution failed: " + e.getMessage());
            }
        });
    }
}
