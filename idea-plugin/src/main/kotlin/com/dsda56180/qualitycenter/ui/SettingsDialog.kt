package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.recipes.RecipeDefinition
import com.dsda56180.qualitycenter.recipes.RecipeRisk
import com.dsda56180.qualitycenter.service.QualityCenterService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.GridLayout
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.border.TitledBorder

class SettingsDialog(
    project: Project,
    private val service: QualityCenterService
) : DialogWrapper(project, true) {

    private val settings = service.settings

    private val checkstyle = JCheckBox("Checkstyle 代码质量", settings.checkstyleEnabled)
    private val gitleaks = JCheckBox("Gitleaks 密钥泄露", settings.gitleaksEnabled)
    private val trivy = JCheckBox("Trivy 依赖漏洞", settings.trivyEnabled)
    private val spotbugs = JCheckBox("SpotBugs 静态缺陷", settings.spotbugsEnabled)
    private val scanOnSave = JCheckBox("保存文件后自动扫描", settings.scanOnSave)
    private val scanOnStartup = JCheckBox("打开项目时自动扫描", settings.scanOnStartup)

    private val rewriteEnabled = JCheckBox("启用深度修复（OpenRewrite）", settings.openRewriteEnabled)
    private val dryRun = JCheckBox("执行前先预演并预览改动", settings.openRewriteDryRunPreview)
    private val compileGate = JCheckBox("修复后校验编译，失败自动回滚", settings.openRewriteCompileGate)
    private val fileSelection = JCheckBox("允许按文件勾选要应用改动", settings.openRewriteFileSelection)
    private val autoRecipes = JCheckBox("自动启用当前项目适用的低风险配方", settings.openRewriteAutoRecipes)
    private val showAllRecipes = JCheckBox("显示全部配方（discover 在线加载）", settings.openRewriteShowAllRecipes)

    private val checkstyleConfig = JBTextField(settings.checkstyleConfig)
    private val gitleaksPath = JBTextField(settings.gitleaksPath)
    private val trivyPath = JBTextField(settings.trivyPath)
    private val trivyTarget = JBTextField(settings.trivyScanTarget)

    private val recipeBoxes = mutableListOf<Pair<RecipeDefinition, JCheckBox>>()

    init {
        title = "质量中心设置"
        init()
        setOKButtonText("保存")
        setCancelButtonText("取消")
    }

    fun openAndSave(): Boolean = showAndGet()

    override fun createCenterPanel(): JComponent {
        val root = JPanel(BorderLayout(0, JBUI.scale(10)))
        root.preferredSize = Dimension(JBUI.scale(760), JBUI.scale(620))
        root.border = JBUI.Borders.empty(4)

        val left = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        left.add(section("扫描器", JPanel(GridLayout(0, 1, 0, 4)).apply {
            add(checkstyle); add(gitleaks); add(trivy); add(spotbugs); add(scanOnSave); add(scanOnStartup)
        }))
        left.add(section("可执行文件与规则", JPanel(GridLayout(0, 2, 8, 6)).apply {
            add(JLabel("Checkstyle 配置"))
            add(checkstyleConfig)
            add(JLabel("Gitleaks 路径"))
            add(gitleaksPath)
            add(JLabel("Trivy 路径"))
            add(trivyPath)
            add(JLabel("Trivy 扫描目标"))
            add(trivyTarget)
        }))
        left.add(section("深度修复", JPanel(GridLayout(0, 1, 0, 4)).apply {
            add(rewriteEnabled); add(dryRun); add(compileGate); add(fileSelection); add(autoRecipes); add(showAllRecipes)
        }))

        val recipePanel = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        val selected = settings.openRewriteRecipes.toSet()
        val library = service.recipesForUi()
        RecipeRisk.entries.forEach { risk ->
            val group = library.filter { it.risk == risk }
            if (group.isEmpty()) return@forEach
            recipePanel.add(JLabel(risk.label).apply { border = JBUI.Borders.emptyTop(8); font = font.deriveFont(font.style or java.awt.Font.BOLD) })
            group.forEach { recipe ->
                val box = JCheckBox(recipe.label, recipe.id in selected)
                box.toolTipText = recipe.description
                recipeBoxes += recipe to box
                recipePanel.add(box)
            }
        }
        if (service.state.discoveringRecipes) {
            recipePanel.add(JLabel("正在加载全部配方…"))
        }
        val recipeScroll = JBScrollPane(recipePanel).apply {
            preferredSize = Dimension(JBUI.scale(760), JBUI.scale(220))
            border = TitledBorder("深度修复配方")
        }
        root.add(left, BorderLayout.NORTH)
        root.add(recipeScroll, BorderLayout.CENTER)
        return root
    }

    private fun section(title: String, content: JPanel): JPanel =
        JPanel(BorderLayout()).apply {
            border = TitledBorder(title)
            add(content, BorderLayout.CENTER)
            (layout as? BorderLayout)?.vgap = JBUI.scale(6)
        }

    override fun doOKAction() {
        settings.checkstyleEnabled = checkstyle.isSelected
        settings.gitleaksEnabled = gitleaks.isSelected
        settings.trivyEnabled = trivy.isSelected
        settings.spotbugsEnabled = spotbugs.isSelected
        settings.scanOnSave = scanOnSave.isSelected
        settings.scanOnStartup = scanOnStartup.isSelected
        settings.openRewriteEnabled = rewriteEnabled.isSelected
        settings.openRewriteDryRunPreview = dryRun.isSelected
        settings.openRewriteCompileGate = compileGate.isSelected
        settings.openRewriteFileSelection = fileSelection.isSelected
        settings.openRewriteAutoRecipes = autoRecipes.isSelected
        settings.openRewriteShowAllRecipes = showAllRecipes.isSelected
        settings.checkstyleConfig = checkstyleConfig.text.trim()
        settings.gitleaksPath = gitleaksPath.text.trim()
        settings.trivyPath = trivyPath.text.trim()
        settings.trivyScanTarget = trivyTarget.text.trim()
        settings.openRewriteRecipes = recipeBoxes.filter { it.second.isSelected }.map { it.first.id }
        service.notifyInfo("设置已保存，下次扫描生效。")
        if (showAllRecipes.isSelected) {
            service.discoverRecipesIfNeeded()
        }
        super.doOKAction()
    }
}
