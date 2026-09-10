package com.pieces.android.companion;

import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.prompt.Candidate;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.GenerativeModel;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * On-device Gemini Nano (AICore) triage for captured screen text, run BEFORE
 * a passive capture is forwarded to PiecesOS. Ported from the same pattern
 * already proven in two sibling projects: bear-house-classic's
 * OnDeviceGenAIPlugin (the Capacitor plugin shape / ML Kit Prompt API
 * plumbing) and registry-app's contextual-coach GeminiNanoGapEvaluator (the
 * structured-JSON-with-hallucination-guard classification pattern).
 *
 * Every failure path (API unavailable, malformed response, exception)
 * resolves with ok=false rather than rejecting — callers fall back to
 * sending the raw captured text unchanged, same as today. Triage is a
 * best-effort improvement, never a blocker.
 */
@CapacitorPlugin(name = "OnDeviceTriage")
public class OnDeviceTriagePlugin extends Plugin {

    private final Executor executor = Executors.newSingleThreadExecutor();

    private static final java.util.Set<String> VALID_CATEGORIES = new java.util.HashSet<>(java.util.Arrays.asList(
        "shopping", "travel", "communication", "productivity", "entertainment",
        "finance_adjacent", "reading", "other"
    ));

    // Drop-if-busy guard: real inference takes ~2-3s, longer than
    // PiecesAccessibilityService's 2s debounce — under real scrolling,
    // overlapping triage() calls are expected, not an edge case. A second
    // call arriving mid-inference resolves notOk() immediately (caller falls
    // back to raw text) rather than queuing behind the first — a stale
    // summary for whatever screen was showing 2+ seconds ago is worse than
    // no summary at all.
    private final java.util.concurrent.atomic.AtomicBoolean triageInFlight =
        new java.util.concurrent.atomic.AtomicBoolean(false);

    // checkAvailability's result doesn't change mid-process (the device's
    // AICore support is fixed), so it's checked once and cached — not just
    // as an optimization but because every call into Generation.getClient()
    // opens a native session (see the close()-per-call comment on triage()
    // below), and there's no reason to open a second one just to re-answer
    // the same yes/no question.
    private volatile String cachedAvailabilityStatus;

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        String cached = cachedAvailabilityStatus;
        if (cached != null) {
            JSObject result = new JSObject();
            result.put("status", cached);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT < 26) {
            cachedAvailabilityStatus = "unavailable";
            JSObject result = new JSObject();
            result.put("status", "unavailable");
            call.resolve(result);
            return;
        }
        GenerativeModel client = Generation.INSTANCE.getClient();
        try {
            GenerativeModelFutures model = GenerativeModelFutures.from(client);
            Futures.addCallback(model.checkStatus(), new FutureCallback<Integer>() {
                @Override
                public void onSuccess(Integer status) {
                    client.close();
                    String s = statusToString(status);
                    cachedAvailabilityStatus = s;
                    JSObject result = new JSObject();
                    result.put("status", s);
                    call.resolve(result);
                }

                @Override
                public void onFailure(Throwable t) {
                    client.close();
                    cachedAvailabilityStatus = "unavailable";
                    JSObject result = new JSObject();
                    result.put("status", "unavailable");
                    call.resolve(result);
                }
            }, executor);
        } catch (Exception e) {
            client.close();
            cachedAvailabilityStatus = "unavailable";
            JSObject result = new JSObject();
            result.put("status", "unavailable");
            call.resolve(result);
        }
    }

    /**
     * Summarizes/classifies captured screen text. Input: { appLabel, text }.
     * Output: { ok: true, summary, category } on success, { ok: false } on
     * any failure — never rejects, so callers can always fall back to the
     * raw text uniformly, without branching on why triage didn't run.
     */
    @PluginMethod
    public void triage(PluginCall call) {
        String appLabel = call.getString("appLabel", "");
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.resolve(notOk());
            return;
        }
        if (Build.VERSION.SDK_INT < 26) {
            call.resolve(notOk());
            return;
        }
        if (!triageInFlight.compareAndSet(false, true)) {
            call.resolve(notOk());
            return;
        }

        // A fresh client per call, closed in every path below (success,
        // failure, and the catch block). GenerativeModel.close() is a real
        // method on the API (confirmed via javap on the AAR) — found
        // empirically 2026-08-30 that NOT closing leaves the native AICore
        // session open, and every subsequent call in the same process then
        // fails with AiCoreInferenceHelper statusCode=30 (only recoverable
        // by force-stopping the app). A cached/reused client made this
        // worse, not better — it guaranteed every call after the first hit
        // an already-open, already-spent session.
        GenerativeModel client = Generation.INSTANCE.getClient();
        try {
            GenerativeModelFutures model = GenerativeModelFutures.from(client);
            String prompt = buildPrompt(appLabel, text);
            GenerateContentRequest request = new GenerateContentRequest.Builder(new TextPart(prompt)).build();

            Futures.addCallback(model.generateContent(request), new FutureCallback<GenerateContentResponse>() {
                @Override
                public void onSuccess(GenerateContentResponse response) {
                    client.close();
                    triageInFlight.set(false);
                    List<Candidate> candidates = response.getCandidates();
                    if (candidates.isEmpty()) {
                        call.resolve(notOk());
                        return;
                    }
                    JSObject parsed = parseVerdict(candidates.get(0).getText());
                    call.resolve(parsed != null ? parsed : notOk());
                }

                @Override
                public void onFailure(Throwable t) {
                    client.close();
                    triageInFlight.set(false);
                    call.resolve(notOk());
                }
            }, executor);
        } catch (Exception e) {
            client.close();
            triageInFlight.set(false);
            call.resolve(notOk());
        }
    }

    private static JSObject notOk() {
        JSObject result = new JSObject();
        result.put("ok", false);
        return result;
    }

    private String buildPrompt(String appLabel, String text) {
        // Bounded input, same MAX_TEXT_CHARS discipline as
        // PiecesAccessibilityService.extractText — a huge captured blob
        // shouldn't blow up the prompt.
        String bounded = text.length() > 4000 ? text.substring(0, 4000) : text;
        return "You are summarizing captured on-screen text from an Android app, for a personal "
            + "context-tracking tool. Never include account numbers, balances, passwords, or other "
            + "sensitive identifiers in the summary even if present in the source text — describe the "
            + "activity, not the data.\n\n"
            + "App: " + appLabel + "\n"
            + "On-screen text:\n" + bounded + "\n\n"
            + "Write a detailed summary (2-4 sentences) of what the user appears to be doing. Preserve "
            + "concrete, non-sensitive specifics from the source text where present — item/product/media "
            + "titles, names, quantities, prices, dates, locations, exact button/link labels — rather than "
            + "paraphrasing them away. Still never include account numbers, balances, passwords, or other "
            + "sensitive identifiers, per the instruction above.\n\n"
            + "Respond with ONLY a JSON object, no other text, matching this shape:\n"
            + "{\"summary\": \"the detailed summary described above\", "
            + "\"category\": one of \"shopping\",\"travel\",\"communication\",\"productivity\","
            + "\"entertainment\",\"finance_adjacent\",\"reading\",\"other\"}";
    }

    /** Returns null on any malformed/non-JSON/invalid-category response — caller maps that to notOk(). */
    private JSObject parseVerdict(String raw) {
        if (raw == null) return null;
        try {
            int jsonStart = raw.indexOf('{');
            int jsonEnd = raw.lastIndexOf('}');
            if (jsonStart == -1 || jsonEnd == -1 || jsonEnd < jsonStart) return null;
            JSONObject json = new JSONObject(raw.substring(jsonStart, jsonEnd + 1));
            String summary = json.optString("summary", null);
            String category = json.optString("category", null);
            if (summary == null || summary.isEmpty() || category == null) return null;
            // Guard against a hallucinated category the same way
            // GeminiNanoGapEvaluator rejects a mismatched detectedCategory —
            // reject, don't coerce into something the caller didn't expect.
            if (!VALID_CATEGORIES.contains(category)) return null;

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("summary", summary);
            result.put("category", category);
            return result;
        } catch (JSONException e) {
            return null;
        }
    }

    private static String statusToString(int status) {
        if (status == FeatureStatus.AVAILABLE) return "available";
        if (status == FeatureStatus.DOWNLOADABLE) return "downloadable";
        if (status == FeatureStatus.DOWNLOADING) return "downloading";
        return "unavailable";
    }
}
