package com.nexa.aibot

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * chrome.storage.local for the app. Every value is stored as JSON text under
 * its own key (wrapped as {"v": value} so nulls, arrays and objects all round
 * trip), because the JavaScript bridge only carries strings. One file, shared
 * by the trading page's shim and the settings screen's shim, so a setting
 * written in one is read by the other.
 */
class Prefs(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("nexa.storage", Context.MODE_PRIVATE)

    /** Every stored key with its decoded value, as one JSON object. */
    fun getAll(): JSONObject {
        val out = JSONObject()
        for ((key, raw) in prefs.all) {
            if (raw !is String) continue
            try {
                out.put(key, JSONObject(raw).get("v"))
            } catch (_: Exception) {
                // An unreadable value is dropped rather than surfaced as text.
            }
        }
        return out
    }

    /** One key's decoded value (a JSONObject for objects), or null. */
    fun get(key: String): Any? {
        val raw = prefs.getString(key, null) ?: return null
        return try {
            JSONObject(raw).opt("v")
        } catch (_: Exception) {
            null
        }
    }

    /** Stores every key of `items`; returns the keys written. */
    fun set(items: JSONObject): List<String> {
        val editor = prefs.edit()
        val written = ArrayList<String>()
        val names = items.keys()
        while (names.hasNext()) {
            val key = names.next()
            editor.putString(key, JSONObject().put("v", items.get(key)).toString())
            written.add(key)
        }
        editor.apply()
        return written
    }

    /** Removes every key named in `keys`; returns the keys removed. */
    fun remove(keys: JSONArray): List<String> {
        val editor = prefs.edit()
        val removed = ArrayList<String>()
        for (index in 0 until keys.length()) {
            val key = keys.getString(index)
            editor.remove(key)
            removed.add(key)
        }
        editor.apply()
        return removed
    }
}
