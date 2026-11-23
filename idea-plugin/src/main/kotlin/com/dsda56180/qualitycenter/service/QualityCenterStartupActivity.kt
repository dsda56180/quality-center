package com.dsda56180.qualitycenter.service

import com.dsda56180.qualitycenter.util.Maven
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.io.FileUtil
import java.io.File

/** 项目打开后按设置自动扫描；同时初始化 Maven 临时配置目录 */
class QualityCenterStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        if (project.isDefault) {
            return
        }
        val storage = File(PathManager.getSystemPath(), "quality-center")
        FileUtil.createDirectory(storage)
        Maven.init(storage.path)
        val service = project.service<QualityCenterService>()
        // 项目首次打开时 IDEA 正在导入 Maven / 建索引，此时扫描会抢 CPU 和内存
        if (com.intellij.openapi.project.DumbService.getInstance(project).isDumb) {
            return
        }
        kotlinx.coroutines.delay(3000)
        if (com.intellij.openapi.project.DumbService.getInstance(project).isDumb) {
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread { service.scanOnStartupOnce() }
    }
}
