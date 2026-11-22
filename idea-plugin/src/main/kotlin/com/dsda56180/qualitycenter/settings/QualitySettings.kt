package com.dsda56180.qualitycenter.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project

/** 插件设置，按项目保存在 workspace 级 PropertiesComponent 中 */
class QualitySettings(private val project: Project) {

    private val props: PropertiesComponent get() = PropertiesComponent.getInstance(project)

    private fun bool(key: String, def: Boolean): Boolean =
        props.getBoolean("qualityCenter.$key", def)

    private fun setBool(key: String, value: Boolean) =
        props.setValue("qualityCenter.$key", value, false)

    private fun str(key: String, def: String): String =
        props.getValue("qualityCenter.$key") ?: def

    private fun setStr(key: String, value: String) =
        props.setValue("qualityCenter.$key", value)

    private fun list(key: String): List<String> =
        str(key, "").split('\n').map { it.trim() }.filter { it.isNotEmpty() }

    private fun setList(key: String, value: List<String>) =
        setStr(key, value.joinToString("\n"))

    var checkstyleEnabled: Boolean
        get() = bool("checkstyle.enabled", true)
        set(value) = setBool("checkstyle.enabled", value)

    var checkstyleConfig: String
        get() = str("checkstyle.config", "")
        set(value) = setStr("checkstyle.config", value)

    var gitleaksEnabled: Boolean
        get() = bool("gitleaks.enabled", true)
        set(value) = setBool("gitleaks.enabled", value)

    var gitleaksPath: String
        get() = str("gitleaks.path", "")
        set(value) = setStr("gitleaks.path", value)

    var trivyEnabled: Boolean
        get() = bool("trivy.enabled", true)
        set(value) = setBool("trivy.enabled", value)

    var trivyPath: String
        get() = str("trivy.path", "")
        set(value) = setStr("trivy.path", value)

    var trivyScanTarget: String
        get() = str("trivy.scanTarget", "")
        set(value) = setStr("trivy.scanTarget", value)

    var trivyDbRepository: String
        get() = str("trivy.dbRepository", "")
        set(value) = setStr("trivy.dbRepository", value)

    var trivyJavaDbRepository: String
        get() = str("trivy.javaDbRepository", "")
        set(value) = setStr("trivy.javaDbRepository", value)

    var trivyPreferMirror: Boolean
        get() = bool("trivy.preferMirror", true)
        set(value) = setBool("trivy.preferMirror", value)

    var trivyMinSeverity: String
        get() = str("trivy.minSeverity", "low")
        set(value) = setStr("trivy.minSeverity", value)

    var trivyOnlyFixed: Boolean
        get() = bool("trivy.onlyFixed", true)
        set(value) = setBool("trivy.onlyFixed", value)

    var spotbugsEnabled: Boolean
        get() = bool("spotbugs.enabled", true)
        set(value) = setBool("spotbugs.enabled", value)

    var scanOnSave: Boolean
        get() = bool("scanOnSave", true)
        set(value) = setBool("scanOnSave", value)

    var scanOnStartup: Boolean
        get() = bool("scanOnStartup", true)
        set(value) = setBool("scanOnStartup", value)

    var exportForAgent: Boolean
        get() = bool("exportForAgent", true)
        set(value) = setBool("exportForAgent", value)

    var dependencyUpgradeEnabled: Boolean
        get() = bool("dependencyUpgrade.enabled", true)
        set(value) = setBool("dependencyUpgrade.enabled", value)

    var openRewriteEnabled: Boolean
        get() = bool("openRewrite.enabled", true)
        set(value) = setBool("openRewrite.enabled", value)

    var openRewriteDryRunPreview: Boolean
        get() = bool("openRewrite.dryRunPreview", true)
        set(value) = setBool("openRewrite.dryRunPreview", value)

    var openRewriteCompileGate: Boolean
        get() = bool("openRewrite.compileGate", true)
        set(value) = setBool("openRewrite.compileGate", value)

    var openRewriteFileSelection: Boolean
        get() = bool("openRewrite.fileSelection", true)
        set(value) = setBool("openRewrite.fileSelection", value)

    var openRewriteAutoRecipes: Boolean
        get() = bool("openRewrite.autoRecipes", true)
        set(value) = setBool("openRewrite.autoRecipes", value)

    var openRewriteShowAllRecipes: Boolean
        get() = bool("openRewrite.showAllRecipes", false)
        set(value) = setBool("openRewrite.showAllRecipes", value)

    var openRewriteRecipes: List<String>
        get() = list("openRewrite.recipes")
        set(value) = setList("openRewrite.recipes", value)

    var openRewriteRecipeArtifacts: List<String>
        get() = list("openRewrite.recipeArtifacts")
        set(value) = setList("openRewrite.recipeArtifacts", value)

    var openRewritePluginVersion: String
        get() = str("openRewrite.pluginVersion", "5.44.0")
        set(value) = setStr("openRewrite.pluginVersion", value)
}
