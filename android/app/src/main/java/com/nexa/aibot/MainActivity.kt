package com.nexa.aibot

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.Toast
import java.lang.ref.WeakReference

/**
 * The Quotex web platform in a full-screen WebView with the bot injected
 * at document start (BotWebView) — the same files the Chrome extension
 * ships. The floating button opens the extension's popup (SettingsActivity).
 */
class MainActivity : Activity() {

    private lateinit var bot: BotWebView
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The bot only runs while the page is alive and on screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        bot = BotWebView(this)
        webView = bot.view
        if (bot.fallbackScript != null) {
            Toast.makeText(
                this,
                "Old Android System WebView: the bot may miss the first quotes — please update it.",
                Toast.LENGTH_LONG,
            ).show()
        }

        val root = FrameLayout(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        root.addView(buildSettingsButton(), settingsButtonParams())
        setContentView(root)

        PageRef.webView = WeakReference(webView)
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(getString(R.string.start_url))
        }
    }

    /**
     * A navy 14dp tile with the gear — the same icon as the popup's Settings
     * tab, and the one piece of app chrome over Quotex's dark page.
     */
    private fun buildSettingsButton(): ImageButton {
        val button = ImageButton(this)
        button.contentDescription = getString(R.string.open_settings)
        button.setImageResource(R.drawable.ic_settings)
        button.setBackgroundResource(R.drawable.bg_settings_button)
        button.elevation = dp(4).toFloat()
        button.scaleType = ImageView.ScaleType.FIT_CENTER
        val pad = dp(9)
        button.setPadding(pad, pad, pad, pad)
        button.setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        button.setOnLongClickListener {
            webView.reload()
            true
        }
        return button
    }

    private fun settingsButtonParams(): FrameLayout.LayoutParams {
        val size = dp(44)
        val params = FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.END)
        val margin = dp(10)
        params.setMargins(margin, margin, margin, margin)
        return params
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        if (PageRef.current() === webView) PageRef.webView = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        bot.destroy()
        super.onDestroy()
    }
}
