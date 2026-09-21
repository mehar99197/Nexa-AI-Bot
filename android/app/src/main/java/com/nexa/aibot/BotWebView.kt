package com.nexa.aibot

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * A WebView with the bot inside: the Quotex web platform plus the
 * extension's files (assets/bot, copied from the repository root at build
 * time) injected at document start behind assets/shim.js, which stands in
 * for chrome.storage / chrome.runtime. The desktop site is requested because
 * the bot's DOM heuristics were verified on the desktop layout.
 */
class BotWebView(context: Context) {

    val view: WebView = WebView(context)
    private val appContext: Context = context.applicationContext

    /** Only when document-start scripts are unsupported (old System WebView). */
    var fallbackScript: String? = null
        private set

    init {
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.mediaPlaybackRequiresUserGesture = false   // the trade beep
        val chromeVersion = chromeVersionOf(settings.userAgentString)
        settings.userAgentString = desktopUserAgent(chromeVersion)
        // The client hints must tell the same story as the User-Agent. Left
        // alone, the low-entropy hints — the Sec-CH-UA-* headers and
        // navigator.userAgentData — still describe an Android WebView on a
        // phone (mobile, platform Android, brand "Android WebView") under a
        // desktop Linux UA, which any script can read in one line. This is
        // the identity Chrome itself presents in "Desktop site" mode.
        // Providers too old for the API keep the mismatch; shim.js patches
        // navigator.userAgentData there.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            WebSettingsCompat.setUserAgentMetadata(settings, desktopMetadata(chromeVersion))
        }
        // A WebView used to stamp every request with "X-Requested-With:
        // <package name>" — the one header that tells a server this is an
        // app, not Chrome. WebViews that support the allow list send it only
        // to the origins listed, so an empty list is nowhere; older ones
        // ignore this and keep sending it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        if ((appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect from a PC
        }
        view.addJavascriptInterface(Bridge(appContext), BRIDGE_NAME)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(appContext))
            .build()
        view.webChromeClient = WebChromeClient()
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                if (request == null) return null
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // Old WebViews only: inject as early as the page lets us.
                val script = fallbackScript ?: return
                if (view != null && url != null && isTradingUrl(url)) view.evaluateJavascript(script, null)
            }
        }
        installBotScripts()
    }

    /**
     * The shim, then the bot's files in the manifest's order, as document-
     * start scripts on the trading origins — like content scripts, they run
     * before the page's own code opens its WebSocket.
     */
    private fun installBotScripts() {
        val css = readAsset("bot/style.css")
        // Non-enumerable, and configurable so content.js can delete it once
        // the stylesheet is in the shadow root: nothing of the bot should be
        // found by a walk of the page's window.
        val prelude = "Object.defineProperty(globalThis, '__nexaInlineStyle', { value: " +
            JSONObject.quote(css) + ", configurable: true });\n"
        val scripts = ArrayList<String>()
        scripts.add(prelude + readAsset("shim.js"))
        for (name in BOT_SCRIPTS) scripts.add(readAsset("bot/$name"))
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            for (script in scripts) WebViewCompat.addDocumentStartJavaScript(view, script, TRADING_ORIGINS)
        } else {
            fallbackScript = scripts.joinToString("\n;\n")
        }
    }

    private fun readAsset(path: String): String =
        appContext.assets.open(path).use { stream -> String(stream.readBytes(), Charsets.UTF_8) }

    fun destroy() {
        try {
            view.stopLoading()
            view.loadUrl("about:blank")
        } catch (_: Exception) {
            // already gone
        }
        view.destroy()
    }

    companion object {
        /**
         * The global the Java bridge is injected under, in both WebViews.
         * Deliberately says nothing: the trading page shares its window with
         * the bot, and shim.js hides the object from enumeration once it
         * has appeared (assets/shim.js BRIDGE_NAME and popup-shim.js must
         * match).
         */
        const val BRIDGE_NAME = "nxHost"

        /** manifest.json's ISOLATED-world order, minus content.js's own shim. */
        val BOT_SCRIPTS = listOf(
            "inject.js", "strategy.js", "autopilot.js", "horizons.js",
            "candles.js", "settings.js", "content.js",
        )

        /** manifest.json's host patterns, as WebView origin rules. */
        val TRADING_ORIGINS: Set<String> = setOf(
            "https://market-qx.trade", "https://*.market-qx.trade",
            "https://qxbroker.com", "https://*.qxbroker.com",
            "https://quotex.io", "https://*.quotex.io",
            "https://quotex.com", "https://*.quotex.com",
            "https://*.quotex-market.com", "https://*.qx-market.com",
            "https://*.market-qx.pro", "https://*.qxbroker.io",
        )

        private val TRADING_DOMAINS = listOf(
            "market-qx.trade", "qxbroker.com", "quotex.io", "quotex.com",
            "quotex-market.com", "qx-market.com", "market-qx.pro", "qxbroker.io",
        )

        fun isTradingUrl(url: String): Boolean {
            val host = Uri.parse(url).host?.lowercase() ?: return false
            return TRADING_DOMAINS.any { host == it || host.endsWith(".$it") }
        }

        /** The Chrome build in the WebView's own User-Agent, e.g. "138.0.7204.179". */
        fun chromeVersionOf(userAgent: String): String =
            Regex("Chrome/([0-9.]+)").find(userAgent)?.groupValues?.get(1) ?: "128.0.0.0"

        /**
         * The Chrome build behind an Android desktop site identity (Linux
         * x86_64) — the string Chrome itself sends in "Desktop site" mode.
         * Only the major version goes into it: Chrome has reduced its UA to
         * "138.0.0.0" since 2022, so a full build number there is a tell.
         */
        fun desktopUserAgent(chromeVersion: String): String {
            val major = chromeVersion.substringBefore('.')
            return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/$major.0.0.0 Safari/537.36"
        }

        /**
         * User-agent client hints to match desktopUserAgent: what desktop
         * Chrome on Linux reports, with the WebView's real Chrome build as
         * the full version. The first brand is the GREASE entry Chrome
         * always includes; servers are told to ignore it.
         */
        fun desktopMetadata(chromeVersion: String): UserAgentMetadata {
            val major = chromeVersion.substringBefore('.')
            fun brand(name: String, majorVersion: String, fullVersion: String) =
                UserAgentMetadata.BrandVersion.Builder()
                    .setBrand(name).setMajorVersion(majorVersion).setFullVersion(fullVersion).build()
            return UserAgentMetadata.Builder()
                .setBrandVersionList(listOf(
                    brand("Not/A)Brand", "8", "8.0.0.0"),
                    brand("Chromium", major, chromeVersion),
                    brand("Google Chrome", major, chromeVersion),
                ))
                .setFullVersion(chromeVersion)
                .setPlatform("Linux")
                .setPlatformVersion("6.8.0")
                .setArchitecture("x86")
                .setBitness(64)
                .setModel("")
                .setMobile(false)
                .setWow64(false)
                .build()
        }
    }
}
