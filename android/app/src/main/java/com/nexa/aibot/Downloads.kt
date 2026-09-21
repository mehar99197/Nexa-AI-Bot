package com.nexa.aibot

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Writes a text file into the phone's Downloads/NexaAIBot folder: MediaStore
 * on Android 10+ (no permission needed), the app's own external folder below
 * that. Used for the bot's exports (tick journal, trades CSV).
 */
object Downloads {

    fun write(context: Context, name: String, text: String): String {
        val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val mime = when {
            safeName.endsWith(".csv") -> "text/csv"
            safeName.endsWith(".json") -> "application/json"
            else -> "text/plain"
        }
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NexaAIBot")
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore refused the file")
            val stream = resolver.openOutputStream(uri)
                ?: throw IllegalStateException("MediaStore gave no stream")
            stream.use { it.write(bytes) }
            return "Downloads/NexaAIBot/$safeName"
        }
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "NexaAIBot")
        dir.mkdirs()
        val file = File(dir, safeName)
        file.writeBytes(bytes)
        return file.absolutePath
    }
}
