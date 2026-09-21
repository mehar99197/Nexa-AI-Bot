package com.nexa.aibot

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The app's version name, for the popup's version line. */
fun versionName(context: Context): String = try {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"
} catch (_: Exception) {
    "?"
}

/**
 * The trading page's WebView, reachable from the settings screen. Every
 * JavaScript call into it goes through the UI thread, as WebView requires.
 */
object PageRef {
    @Volatile
    var webView: WeakReference<WebView>? = null
    val main = Handler(Looper.getMainLooper())

    fun current(): WebView? = webView?.get()

    /** Runs JavaScript in the trading page; fire and forget. */
    fun run(script: String) {
        main.post { current()?.evaluateJavascript(script, null) }
    }

    /**
     * Runs JavaScript in the trading page and waits (from a non-UI thread)
     * for the JSON encoding of its value. Null when there is no page, when
     * it did not answer in time, or when called from the UI thread itself
     * (which must never block).
     */
    fun call(script: String, timeoutMs: Long): String? {
        if (Looper.myLooper() == Looper.getMainLooper()) return null
        val latch = CountDownLatch(1)
        var result: String? = null
        main.post {
            val view = current()
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(script) { value ->
                    result = value
                    latch.countDown()
                }
            }
        }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return result
    }
}

/**
 * The settings screen while it is open: its activity (so the popup's Trade
 * tab can close it) and its WebView (so the trading page's answers can be
 * delivered into it — see Bridge.sendToPageAsync).
 */
object SettingsRef {
    @Volatile
    var activity: WeakReference<Activity>? = null
    @Volatile
    var webView: WeakReference<WebView>? = null

    fun current(): Activity? = activity?.get()
    fun view(): WebView? = webView?.get()
}

/**
 * The JavaScript interface (BotWebView.BRIDGE_NAME), added to both WebViews. Every
 * method runs on the WebView's JavaBridge thread, so the ones that need the
 * trading page hop to the UI thread through PageRef.
 */
class Bridge(context: Context) {

    private val app: Context = context.applicationContext
    private val prefs = Prefs(app)
    private val version = versionName(app)

    @JavascriptInterface
    fun version(): String = version

    /** The popup's Trade tab: back to the chart (a no-op in the trading page itself). */
    @JavascriptInterface
    fun closeSettings() {
        PageRef.main.post { SettingsRef.current()?.finish() }
    }

    /* ---------------------------- storage ---------------------------- */

    @JavascriptInterface
    fun storageGetAll(): String = prefs.getAll().toString()

    @JavascriptInterface
    fun storageSet(json: String) {
        val items = JSONObject(json)
        prefs.set(items)
        // chrome.storage.onChanged for the trading page: which keys, new values.
        val changes = JSONObject()
        val names = items.keys()
        while (names.hasNext()) {
            val key = names.next()
            changes.put(key, JSONObject().put("newValue", items.get(key)))
        }
        notifyPage(changes)
    }

    @JavascriptInterface
    fun storageRemove(json: String) {
        val keys = JSONArray(json)
        prefs.remove(keys)
        val changes = JSONObject()
        for (index in 0 until keys.length()) changes.put(keys.getString(index), JSONObject())
        notifyPage(changes)
    }

    private fun notifyPage(changes: JSONObject) {
        PageRef.run("window.__nexaAndroid&&window.__nexaAndroid.storageChanged($changes)")
    }

    /* ----------------------------- messages -------------------------- */

    private fun messageScript(json: String): String =
        "(function(){try{return window.__nexaAndroid?window.__nexaAndroid.message($json):null}" +
            "catch(e){return null}})()"

    /**
     * evaluateJavascript hands back the JSON encoding of the value; the
     * page's message() returns a JSON *string*, so unwrap one level.
     * "null" when there was no page, no listener, or no answer.
     */
    private fun unwrapReply(raw: String?): String {
        if (raw == null) return "null"
        return try {
            val value = JSONTokener(raw).nextValue()
            if (value is String) value else "null"
        } catch (_: Exception) {
            "null"
        }
    }

    /**
     * chrome.tabs.sendMessage from the settings screen, the blocking form:
     * relayed into the trading page's onMessage listeners, their reply
     * returned as JSON text. Kept for older popup shims; the settings screen
     * now uses sendToPageAsync, which never blocks its JavaScript.
     */
    @JavascriptInterface
    fun sendToPage(json: String): String = unwrapReply(PageRef.call(messageScript(json), 3000))

    /**
     * The same relay, asynchronous: the request is posted to the trading
     * page and its answer is delivered into the settings screen's WebView as
     * window.__nexaPopup.reply(requestId, json) — "null" when there is no
     * page. Nothing waits on anything; the settings page's own timeout
     * decides when an unanswered request counts as "no page".
     */
    @JavascriptInterface
    fun sendToPageAsync(requestId: String, json: String) {
        val script = messageScript(json)
        val id = JSONObject.quote(requestId)
        val deliver: (String?) -> Unit = { raw ->
            val text = JSONObject.quote(unwrapReply(raw))
            SettingsRef.view()?.evaluateJavascript(
                "window.__nexaPopup&&window.__nexaPopup.reply($id,$text)", null,
            )
        }
        PageRef.main.post {
            val page = PageRef.current()
            if (page == null) deliver(null)
            else page.evaluateJavascript(script) { raw -> deliver(raw) }
        }
    }

    /* ------------------------------ input ---------------------------- */

    /**
     * A real tap on the trading page at (x, y) view pixels — content.js
     * works the point out from the button it wants pressed, and Input sends
     * the finger-down / finger-up MotionEvents through the WebView, queued
     * behind any typing still going out. Answers the ms until the finger
     * lifts (the page's click), or -1 when there is no page to tap.
     */
    @JavascriptInterface
    fun tap(x: Double, y: Double): Double {
        if (!x.isFinite() || !y.isFinite()) return -1.0
        val page = PageRef.current() ?: return -1.0
        return Input.tap(page, x.toFloat(), y.toFloat()).toDouble()
    }

    /**
     * Types an amount into the field the page has focused and selected
     * (content.js selects the stake input first), as hardware key events
     * through the WebView. Digits and a decimal point only, a dozen
     * characters at most. True when there was a page to type into.
     */
    @JavascriptInterface
    fun type(text: String): Boolean {
        if (!Regex("^[0-9.,]{1,12}$").matches(text)) return false
        val page = PageRef.current() ?: return false
        Input.type(page, text)
        return true
    }

    /** A message the page wants the person to see (a platform alarm). */
    @JavascriptInterface
    fun notify(text: String) {
        toast(text.take(200))
    }

    /* ------------------------------ files ---------------------------- */

    /**
     * content.js's exports (tick journal, trades CSV) arrive here as text —
     * a WebView has no download manager for blob: URLs. Written to the
     * phone's Downloads/NexaAIBot folder. Returns where it went, or "".
     */
    @JavascriptInterface
    fun saveFile(name: String, text: String): String {
        return try {
            val where = Downloads.write(app, name, text)
            toast("Saved: $where")
            where
        } catch (error: Exception) {
            toast("Could not save $name: ${error.message}")
            ""
        }
    }

    private fun toast(message: String) {
        PageRef.main.post { Toast.makeText(app, message, Toast.LENGTH_LONG).show() }
    }
}
