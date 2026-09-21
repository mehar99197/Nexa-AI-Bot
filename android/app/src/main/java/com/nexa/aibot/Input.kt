package com.nexa.aibot

import android.content.Context
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import java.util.Random

/**
 * Real input into the trading page, from Bridge.tap and Bridge.type: taps
 * as finger-down / finger-up MotionEvents (with the small roll of a
 * fingertip resting between them), typing as hardware KeyEvents, both
 * dispatched to the WebView itself. They travel the same path a touch on
 * the glass or a keyboard does, so the page receives trusted pointer,
 * touch, mouse, key and input events and a trusted click — which no event
 * content.js builds with dispatchEvent can ever be (isTrusted: false).
 *
 * One serial timeline: a tap asked for while typing is still going out
 * lands after the last key, with the pause a person takes between the
 * amount field and the button. The timeline is worked out on the calling
 * thread (the bridge's), so a caller learns at once when its input will
 * land; the events themselves go out on the UI thread. Coordinates are
 * view pixels, worked out by the page from the element it wants pressed
 * (content.js).
 */
object Input {

    private val random = Random()

    /** uptimeMillis at which the timeline is free again; guarded by this object's lock. */
    private var readyAt = 0L

    private fun between(min: Int, max: Int): Long = (min + random.nextInt(max - min + 1)).toLong()

    /**
     * Runs `action` once the timeline is free, `gapMin..gapMax` ms after
     * whatever went before (or after now, when nothing is pending), and
     * marks the timeline busy for `holdMs` beyond that. Returns when.
     */
    private fun schedule(gapMin: Int, gapMax: Int, holdMs: Long, action: () -> Unit): Long {
        val now = SystemClock.uptimeMillis()
        val at = maxOf(now, readyAt) + between(gapMin, gapMax)
        readyAt = at + holdMs
        PageRef.main.postAtTime(action, at)
        return at
    }

    /* ------------------------------- tap ------------------------------ */

    /** A fingertip's contact patch as the digitizer reports it, fixed for one tap. */
    private class Fingertip(val contact: Float, val size: Float)

    /**
     * A tap at (x, y) view pixels, queued behind whatever the timeline
     * holds. Returns the ms until the finger lifts — when the page's click
     * fires — or -1 when the point is refused. Any thread.
     */
    @Synchronized
    fun tap(view: WebView, x: Float, y: Float): Long {
        if (x.isNaN() || y.isNaN() || x < 0f || y < 0f) return -1
        val now = SystemClock.uptimeMillis()
        // Straight after typing a person glances at the figure, then moves
        // to the button; with nothing pending the tap goes out now.
        val pending = readyAt > now
        val hold = between(60, 130)
        // A fingertip rolls a little while it rests on the glass: none to
        // two moves, each well inside the touch slop, so it is still a tap.
        val moves = random.nextInt(3)
        val at = schedule(if (pending) 250 else 0, if (pending) 600 else 0, hold) {
            if (PageRef.current() !== view || !view.isAttachedToWindow) return@schedule
            if (view.width <= 0 || view.height <= 0 || x >= view.width || y >= view.height) return@schedule
            val onScreen = IntArray(2).also { view.getLocationOnScreen(it) }
            val density = view.resources.displayMetrics.density
            val tip = Fingertip(
                contact = (20f + random.nextFloat() * 10f) * density,   // 20-30 dp across
                size = 0.06f + random.nextFloat() * 0.12f,
            )
            val downTime = SystemClock.uptimeMillis()
            val force = 0.45f + random.nextFloat() * 0.35f
            var fx = x
            var fy = y
            touch(view, onScreen, downTime, downTime, MotionEvent.ACTION_DOWN, fx, fy, force, tip)
            val live = { PageRef.current() === view && view.isAttachedToWindow }
            var t = 0L
            for (i in 0 until moves) {
                t += between(12, 40)
                if (t >= hold) break
                fx += (random.nextFloat() - 0.5f) * 1.5f * density
                fy += (random.nextFloat() - 0.5f) * 1.5f * density
                val mx = fx
                val my = fy
                val pressure = (force + (random.nextFloat() - 0.4f) * 0.08f).coerceIn(0.1f, 1f)
                PageRef.main.postDelayed({
                    if (live()) touch(view, onScreen, downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, mx, my, pressure, tip)
                }, t)
            }
            // A finger rests on the glass for a few dozen milliseconds; only
            // a script lifts in the same millisecond it landed. It lifts
            // where it last rolled to, pressing a little less as it goes.
            PageRef.main.postDelayed({
                if (live()) {
                    val lift = (force - 0.1f).coerceAtLeast(0.05f)
                    touch(view, onScreen, downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, fx, fy, lift, tip)
                }
            }, hold)
        }
        return at + hold - now
    }

    private fun touch(
        view: WebView, onScreen: IntArray, downTime: Long, eventTime: Long,
        action: Int, x: Float, y: Float, force: Float, tip: Fingertip,
    ) {
        val finger = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        // Built at the screen position so getRawX/Y read like a touch on the
        // glass; offsetLocation below makes getX/Y view-local. Computed
        // outside apply, where x, y and pressure would name the fields.
        val screenX = x + onScreen[0]
        val screenY = y + onScreen[1]
        val coords = MotionEvent.PointerCoords().apply {
            this.x = screenX
            this.y = screenY
            this.pressure = force
            size = tip.size
            touchMajor = tip.contact
            touchMinor = tip.contact * 0.85f
            toolMajor = tip.contact
            toolMinor = tip.contact * 0.85f
        }
        val event = MotionEvent.obtain(
            downTime, eventTime, action, 1, arrayOf(finger), arrayOf(coords),
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        event.offsetLocation(-onScreen[0].toFloat(), -onScreen[1].toFloat())
        try {
            view.dispatchTouchEvent(event)
        } finally {
            event.recycle()
        }
    }

    /* ------------------------------ typing ---------------------------- */

    /**
     * Types `text` (digits, a decimal point) into whatever the page has
     * focused and selected — content.js selects the amount field first, so
     * the keys replace its value. One key every 70-160 ms, each held
     * 40-90 ms, like a thumb on a keypad. Any soft keyboard the focus may
     * have raised is put away at the end. Any thread.
     */
    @Synchronized
    fun type(view: WebView, text: String) {
        var last = 0L
        for ((index, ch) in text.withIndex()) {
            val code = keyCodeFor(ch) ?: continue
            val hold = between(40, 90)
            last = schedule(if (index == 0) 0 else 70, if (index == 0) 0 else 160, hold) {
                if (!view.isAttachedToWindow || PageRef.current() !== view) return@schedule
                val downTime = SystemClock.uptimeMillis()
                view.dispatchKeyEvent(KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, code, 0))
                PageRef.main.postDelayed({
                    if (view.isAttachedToWindow) {
                        view.dispatchKeyEvent(KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0))
                    }
                }, hold)
            }
        }
        if (last == 0L) return
        PageRef.main.postAtTime({
            val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.hideSoftInputFromWindow(view.windowToken, 0)
        }, readyAt + 20)
    }

    private fun keyCodeFor(ch: Char): Int? = when (ch) {
        in '0'..'9' -> KeyEvent.KEYCODE_0 + (ch - '0')
        '.' -> KeyEvent.KEYCODE_PERIOD
        ',' -> KeyEvent.KEYCODE_COMMA
        else -> null
    }
}
