package com.pieces.android.companion;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.components.containers.Embedding;
import com.google.mediapipe.tasks.components.containers.EmbeddingResult;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder;
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder.TextEmbedderOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * MediaPipe Text Embedder over the Capacitor bridge, powering /search's
 * local semantic ranking. Same plugin shape and "collapse every failure to
 * ok=false" discipline as OnDeviceTriagePlugin — callers (textEmbedder.ts →
 * semanticSearch.ts) fall back to a plain substring filter when embedding
 * is unavailable.
 *
 * The model ("universal_sentence_encoder.tflite", ~6MB, 100-dim output) is
 * bundled in assets/ and committed to the repo as a release artifact, like
 * src/data/playCategories.json. setL2Normalize(true) means cosine
 * similarity in JS is a plain dot product.
 */
@CapacitorPlugin(name = "TextEmbedder")
public class TextEmbedderPlugin extends Plugin {

    private static final String MODEL_ASSET = "universal_sentence_encoder.tflite";

    private final Executor executor = Executors.newSingleThreadExecutor();
    // volatile: written on the executor thread during async init, read from
    // whatever thread a @PluginMethod runs on.
    private volatile TextEmbedder embedder;
    private volatile boolean initFailed = false;

    @Override
    public void load() {
        super.load();
        // TextEmbedder.createFromOptions memory-maps a ~6MB model. Doing that
        // synchronously in load() (which Capacitor calls on the UI thread at
        // activity start) is an ANR risk, so it's pushed to the executor.
        // Until it finishes, checkAvailability() reports "unavailable" and
        // the JS caller uses its substring fallback — exactly the discipline
        // this plugin already commits to.
        executor.execute(() -> {
            try {
                BaseOptions baseOptions = BaseOptions.builder()
                        .setModelAssetPath(MODEL_ASSET)
                        .build();
                TextEmbedderOptions options = TextEmbedderOptions.builder()
                        .setBaseOptions(baseOptions)
                        .setL2Normalize(true)
                        .setQuantize(false)
                        .build();
                embedder = TextEmbedder.createFromOptions(getContext(), options);
            } catch (Throwable t) {
                initFailed = true;
            }
        });
    }

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        // Queue behind the load() init task on the same executor so a
        // cold-start caller sees the settled state, not a transient
        // "unavailable" while the model is still mapping.
        executor.execute(() -> {
            JSObject ret = new JSObject();
            ret.put("status", (embedder != null && !initFailed) ? "available" : "unavailable");
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void embed(PluginCall call) {
        String text = call.getString("text", "");
        executor.execute(() -> {
            JSObject ret = new JSObject();
            try {
                TextEmbedder e = embedder;
                if (e == null) {
                    ret.put("ok", false);
                    call.resolve(ret);
                    return;
                }
                EmbeddingResult result = e.embed(text).embeddingResult();
                List<Embedding> embeddings = result.embeddings();
                if (embeddings.isEmpty()) {
                    ret.put("ok", false);
                    call.resolve(ret);
                    return;
                }
                ret.put("ok", true);
                ret.put("vector", floatArrayToJson(embeddings.get(0).floatEmbedding()));
                call.resolve(ret);
            } catch (Throwable t) {
                ret.put("ok", false);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void embedBatch(PluginCall call) {
        JSArray textsArr = call.getArray("texts", new JSArray());
        executor.execute(() -> {
            JSObject ret = new JSObject();
            JSONArray vectors = new JSONArray();
            for (int i = 0; i < textsArr.length(); i++) {
                try {
                    String text = textsArr.getString(i);
                    TextEmbedder e = embedder;
                    if (e == null) {
                        vectors.put(JSONObject.NULL);
                        continue;
                    }
                    EmbeddingResult result = e.embed(text).embeddingResult();
                    List<Embedding> embeddings = result.embeddings();
                    if (embeddings.isEmpty()) {
                        vectors.put(JSONObject.NULL);
                    } else {
                        vectors.put(floatArrayToJson(embeddings.get(0).floatEmbedding()));
                    }
                } catch (Throwable inner) {
                    vectors.put(JSONObject.NULL);
                }
            }
            ret.put("vectors", vectors);
            call.resolve(ret);
        });
    }

    private static JSONArray floatArrayToJson(float[] arr) throws org.json.JSONException {
        JSONArray out = new JSONArray();
        // Android's org.json.JSONArray.put(double) is declared to throw
        // JSONException (on NaN/Infinity); an L2-normalized embedding never
        // contains those, but the checked exception still has to be handled —
        // it propagates to the caller's catch (Throwable), which maps to
        // ok=false / a null slot, consistent with every other failure path.
        for (float v : arr) out.put((double) v);
        return out;
    }
}
