package com.dsda56180.qualitycenter.actions

import com.dsda56180.qualitycenter.service.QualityCenterService
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service

class ScanAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<QualityCenterService>()?.scan()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

class DeepFixAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<QualityCenterService>()?.deepFix()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

class UpgradeAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<QualityCenterService>()?.upgradeDependencies()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}
