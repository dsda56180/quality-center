import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.10.5"
}

group = "com.dsda56180"
version = "0.1.0"

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
    pluginConfiguration {
        name = "Quality Center"
        version = project.version.toString()
        description = """
            面向 Java / Maven 项目的代码质量中心：Checkstyle 代码质量、Gitleaks 密钥泄露、
            Trivy 依赖漏洞、SpotBugs 静态缺陷扫描，并支持 OpenRewrite 深度修复与 CVE 依赖升级。
        """.trimIndent()
        vendor {
            name = "dsda56180"
            url = "https://github.com/dsda56180/quality-center"
        }
        ideaVersion {
            sinceBuild = "233"
            untilBuild = "263.*"
        }
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
