package com.nexa.aibot

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.lang.ref.WeakReference

/**
 * The extension's popup.html, full screen. Served from assets on a real
 * origin (WebViewAssetLoader), with assets/popup-shim.js standing in for
 * chrome.storage (the app's SharedPreferences) and chrome.tabs (relayed by
 * Bridge into the trading page). The page's own scripts run unchanged, so
 * this screen is the popup: same hero card, same settings, same buttons —
 * plus a Trade tab in its bottom nav that closes this screen (Bridge.closeSettings).
 */
class SettingsActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.setBackgroundColor(getColor(R.color.nexa_bg))
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        webView.addJavascriptInterface(Bridge(this), BotWebView.BRIDGE_NAME)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                if (request == null) return null
                return assetLoader.shouldInterceptRequest(request.url)
            }
        }
        SettingsRef.activity = WeakReference(this)
        SettingsRef.webView = WeakReference(webView)
        webView.loadUrl(POPUP_URL)
    }

    override fun onDestroy() {
        if (SettingsRef.current() === this) {
            SettingsRef.activity = null
            SettingsRef.webView = null
        }
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val POPUP_URL = "https://appassets.androidplatform.net/assets/bot/popup.html"
    }
}
