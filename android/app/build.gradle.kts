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
            if (line.contains("<script src=\"settings.js\"></script>"))
                "  <script src=\"../popup-shim.js\"></script>\n$line"
            else line
        }
    }
    into(layout.projectDirectory.dir("src/main/assets/bot"))
}

tasks.named("preBuild") {
    dependsOn(copyBotAssets)
}
