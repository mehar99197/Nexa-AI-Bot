// Nexa AI Bot — Android wrapper. Open this folder in Android Studio, or build
// in CI (.github/workflows/android.yml): `gradle assembleDebug`.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "NexaAIBot"
include(":app")
