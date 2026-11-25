const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildConsolidationSuggestions } = require('../out/duplicates.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-dup-'));
fs.mkdirSync(path.join(root, 'src', 'main', 'java', 'demo'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'pom.xml'),
  `<project><modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <dependencies>
    <dependency><groupId>com.alibaba</groupId><artifactId>fastjson</artifactId><version>1.2.83</version></dependency>
    <dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId><version>2.10.1</version></dependency>
    <dependency><groupId>log4j</groupId><artifactId>log4j</artifactId><version>1.2.17</version></dependency>
    <dependency><groupId>commons-logging</groupId><artifactId>commons-logging</artifactId><version>1.2</version></dependency>
    <dependency><groupId>com.squareup.okhttp3</groupId><artifactId>okhttp</artifactId><version>4.9.2</version></dependency>
    <dependency><groupId>org.apache.httpcomponents</groupId><artifactId>httpclient</artifactId><version>4.5.13</version></dependency>
    <dependency><groupId>mysql</groupId><artifactId>mysql-connector-java</artifactId><version>8.0.28</version></dependency>
    <dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.10</version></dependency>
  </dependencies></project>`
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'A.java'),
  'package demo;\nimport com.alibaba.fastjson.JSON;\nclass A {}\n'
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'B.java'),
  'package demo;\nimport com.alibaba.fastjson.JSONObject;\nclass B {}\n'
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'C.java'),
  'package demo;\nimport com.google.gson.Gson;\nclass C {}\n'
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'D.java'),
  'package demo;\nimport org.apache.log4j.Logger;\nclass D {}\n'
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'E.java'),
  'package demo;\nimport okhttp3.OkHttpClient;\nclass E {}\n'
);
fs.writeFileSync(
  path.join(root, 'src', 'main', 'java', 'demo', 'F.java'),
  'package demo;\nimport org.apache.http.client.HttpClient;\nclass F {}\n'
);

const suggestions = buildConsolidationSuggestions(root);
const duplicate = suggestions.find((item) => item.title.startsWith('JSON 实现收敛'));
const logging = suggestions.find((item) => item.title.startsWith('日志实现收敛'));
const http = suggestions.find((item) => item.title.startsWith('HTTP 客户端收敛'));
const bom = suggestions.find((item) => item.title.startsWith('BOM 版本统一'));
const checks = {
  hasJson: Boolean(duplicate),
  jsonNamesBothLibraries: Boolean(duplicate && duplicate.title.includes('fastjson') && duplicate.title.includes('Gson')),
  jsonUsageCounted: Boolean(duplicate && duplicate.detail.includes('fastjson 2 个文件') && duplicate.detail.includes('Gson 1 个文件')),
  hasLogging: Boolean(logging && logging.title.includes('Log4j 1.x') && logging.title.includes('Commons Logging')),
  hasHttp: Boolean(http && http.title.includes('OkHttp') && http.title.includes('Apache HttpClient 4')),
  hasBom: Boolean(bom && bom.title.startsWith('BOM 版本统一') && bom.impact >= 2),
  noAutoDelete: Boolean(duplicate && duplicate.detail.includes('不会自动删依赖')),
  impactLabels: Boolean(duplicate && duplicate.impactLabel === '处引用' && bom && bom.impactLabel === '个依赖')
};
console.log(checks);
fs.rmSync(root, { recursive: true, force: true });
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
