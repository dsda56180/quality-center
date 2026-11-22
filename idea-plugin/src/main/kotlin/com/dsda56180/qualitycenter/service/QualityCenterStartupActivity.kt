package com.dsda56180.qualitycenter.service

import com.dsda56180.qualitycenter.util.Maven
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.util.io.FileUtil
import java.io.File

/** 项目打开后按设置自动扫描；同时初始化 Maven 临时配置目录 */
class QualityCenterStartupActivity : StartupActivity {

    override fun runActivity(project: Project) {
        if (project.isDefault) {
            return
        }
        val storage = File(PathManager.getSystemPath(), "quality-center")
        FileUtil.createDirectory(storage)
        Maven.init(storage.path)
        val service = project.getService(QualityCenterService::class.java) ?: return
        ApplicationManager.getApplication().executeOnPooledThread { service.scanOnStartupOnce() }
    }
}
