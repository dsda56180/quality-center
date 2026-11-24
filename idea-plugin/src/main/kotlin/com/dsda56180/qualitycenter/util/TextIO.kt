package com.dsda56180.qualitycenter.util

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * 文本解码：先按 UTF-8 严格解码，遇到非法字节就回退到 GB18030。
 *
 * 老项目（GBK 源码 + pom 里 project.build.sourceEncoding=GBK）里，OpenRewrite 生成的
 * patch 文件、git diff 的输出都是 GBK 字节。直接按 UTF-8 读会变成「锟斤拷」式乱码，
 * 先严格试 UTF-8、失败再按 GB18030（GBK/GB2312 的超集）解一遍即可正确显示中文。
 */
object TextIO {
    private val gb18030: Charset = Charset.forName("GB18030")

    fun decode(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            String(bytes, gb18030)
        }
    }
}
