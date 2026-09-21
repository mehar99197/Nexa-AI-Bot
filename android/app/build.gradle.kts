import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nexa.aibot"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nexa.aibot"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.2.0"
    }

    // Release signing. android/keystore.properties (git-ignored; see
    // keystore.properties.example) names the key. Without it the release
    // APK is signed with the debug key so it still installs. Either way it
    // is a release build: not debuggable, and BotWebView leaves remote
    // WebView inspection off.
    val keystore = Properties()
    val keystoreFile = rootProject.file("keystore.properties")
    if (keystoreFile.exists()) keystoreFile.inputStream().use { keystore.load(it) }
    signingConfigs {
        if (keystore.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8 shrinks and renames the app code; the @JavascriptInterface
            // methods the page calls by name are kept (proguard-rules.pro).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // WebViewAssetLoader (serves popup.html from assets on a real origin) and
    // addDocumentStartJavaScript (runs the bot at document start, like a
    // content script — before the page's own scripts open the WebSocket).
    implementation("androidx.webkit:webkit:1.11.0")
}

// The bot's files are the single source of truth: the repository root holds
// the extension, and every build copies exactly those files into
// assets/bot/. popup.html gets one extra line — the Android shim that stands
// in for chrome.storage / chrome.tabs — before its own scripts.
val botFiles = listOf(
    "inject.js", "strategy.js", "autopilot.js", "horizons.js", "candles.js",
    "settings.js", "content.js", "style.css", "popup.html", "popup.css", "popup.js",
    "icons/icon48.png",
)

/** The shim tag copyBotAssets injects into popup.html, and then verifies. */
val POPUP_SHIM_TAG = "<script src=\"../popup-shim.js\"></script>"

val copyBotAssets = tasks.register<Copy>("copyBotAssets") {
    description = "Copies the extension's files from the repository root into assets/bot."
    val repoRoot = rootProject.projectDir.parentFile
    from(repoRoot) {
        include(botFiles)
        exclude("popup.html")
    }
    from(repoRoot) {
        include("popup.html")
        filter { line: String ->
            if (line.contains("<script src=\"settings.js\"></script>")) "  $POPUP_SHIM_TAG\n$line"
            else line
        }
    }
    into(layout.projectDirectory.dir("src/main/assets/bot"))
    // The filter above keys off one exact line in popup.html. If that line
    // ever changes the filter silently does nothing, the settings screen
    // loads without chrome.storage and fails at runtime with no clue why —
    // so check the outcome here and stop the build instead.
    doLast {
        val copied = layout.projectDirectory.file("src/main/assets/bot/popup.html").asFile
        val html = copied.readText()
        val shimAt = html.indexOf(POPUP_SHIM_TAG)
        val settingsAt = html.indexOf("src=\"settings.js\"")
        val injections = html.split(POPUP_SHIM_TAG).size - 1
        if (shimAt < 0) throw GradleException(
            "popup.html was copied without $POPUP_SHIM_TAG. The copyBotAssets filter looks for the " +
                "line <script src=\"settings.js\"></script>, which popup.html no longer has in that " +
                "exact form. Without the shim the app's settings screen has no chrome.storage. " +
                "Update the filter to match popup.html's current script tag.",
        )
        if (injections != 1) throw GradleException(
            "popup.html was copied with $injections copies of $POPUP_SHIM_TAG; expected exactly 1.",
        )
        if (settingsAt >= 0 && shimAt > settingsAt) throw GradleException(
            "popup.html loads $POPUP_SHIM_TAG after settings.js; the shim must come first, " +
                "because the scripts after it expect chrome.storage to exist.",
        )
    }
}

tasks.named("preBuild") {
    dependsOn(copyBotAssets)
}
