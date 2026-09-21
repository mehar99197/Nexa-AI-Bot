# Nexa AI Bot — R8 rules for the release build.

# The page calls the app's bridge object (BotWebView.BRIDGE_NAME) by method
# name (shim.js, popup-shim.js): storageGetAll, tap, saveFile, ... R8 must
# not rename or drop them. The default proguard-android-optimize.txt keeps annotated
# methods too; this makes the dependency explicit.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.nexa.aibot.Bridge { public *; }

# Keep line numbers in stack traces (ANR / crash reports stay readable).
-keepattributes SourceFile,LineNumberTable
