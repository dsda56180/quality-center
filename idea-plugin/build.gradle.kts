import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.10.5"
}

group = "com.dsda56180"
// 本地默认版本；CI 发布时通过 -PpluginVersion=<tag版本> 覆盖
version = providers.gradleProperty("pluginVersion").getOrElse("0.1.26")

repositories {
    maven("https://maven.aliyun.com/repository/public")
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    intellijPlatform {
        intellijIdeaUltimate("2026.3")
        bundledPlugin("com.intellij.java")
        instrumentationTools()
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xjvm-default=all")
        // IntelliJ 2026.3 平台库由更新版本的 Kotlin 编译，放开元数据版本检查
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}

intellijPlatform {
    buildSearchableOptions = false
    pluginVerification {
        ides {
            local("D:/Tools/IntelliJ IDEA 2026.3")
        }
    }
    pluginConfiguration {
        name = "Quality Center"
        version = project.version.toString()
        description = "Quality Center is a code quality dashboard for Java and Maven projects: Checkstyle, Gitleaks, Trivy, SpotBugs, OpenRewrite fixes and dependency upgrades."
        vendor {
            name = "dsda56180"
            url = "https://github.com/dsda56180/quality-center"
        }
        ideaVersion {
            // 架构所用 API（ProjectActivity / @Service / ActionUpdateThread / JBTabs）自 2023.3 起可用
            sinceBuild = "233"
        }
    }
    publishing {
        // 发布 token 通过 GitHub Actions 的 PUBLISH_TOKEN secret 注入
        token = providers.environmentVariable("PUBLISH_TOKEN")
        channels = listOf("default")
    }
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions {
        freeCompilerArgs.add("-Xjvm-default=all")
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}

