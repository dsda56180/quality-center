package com.dsda56180.qualitycenter.actions

import com.dsda56180.qualitycenter.service.QualityCenterService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class ScanAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.getService(QualityCenterService::class.java)?.scan()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class DeepFixAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.getService(QualityCenterService::class.java)?.deepFix()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class UpgradeAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.getService(QualityCenterService::class.java)?.upgradeDependencies()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}
