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

const suggestions = buildConsolidationSuggestions(root);
const duplicate = suggestions.find((item) => item.category === 'duplicate');
const checks = {
  hasSuggestion: Boolean(duplicate),
  namesBothLibraries: Boolean(duplicate && duplicate.title.includes('fastjson') && duplicate.title.includes('Gson')),
  canonicalJackson: Boolean(duplicate && duplicate.title.includes('Jackson')),
  usageCounted: Boolean(duplicate && duplicate.detail.includes('fastjson 2 个文件') && duplicate.detail.includes('Gson 1 个文件')),
  noAutoDelete: Boolean(duplicate && duplicate.detail.includes('不会自动删依赖')),
  hasImpact: Boolean(duplicate && duplicate.impact >= 3)
};
console.log(checks);
fs.rmSync(root, { recursive: true, force: true });
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
