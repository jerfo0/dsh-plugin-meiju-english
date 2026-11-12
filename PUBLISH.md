# 发布清单（本地用，不发 npm）

这个目录是 `Meiju_English_learning` 的**可发布副本**，只含插件源码与工具，不含本机生成的剧集物料。

## 0. 先改成你的仓库地址

`package.json` 和 `README.md` 里的 `jerfo0` 是初始占位（取自本机 git 全局配置），推 GitHub 前全局替换成你的用户名/仓库名：

```powershell
cd H:\deepseek_harness\Meiju_English_learning_release
# 例：改成 yourname / dsh-plugin-meiju-english
(Get-Content package.json) -replace 'jerfo0','yourname' | Set-Content package.json
(Get-Content README.md)   -replace 'jerfo0','yourname' | Set-Content README.md
(Get-Content PUBLISH.md)  -replace 'jerfo0','yourname' | Set-Content PUBLISH.md
```

不想叫 `dsh-plugin-meiju-english` 的话，同时改：`package.json` 的 `name`、`plugin/package.json` 的 `name`、`plugin/cordis.patch.yml` 里的 `name`、`plugin/client.js` 顶部的 bundle id（`window.__ModuleLoader__.load({ id: ...`）——四者必须一致。

## 1. 推 GitHub

仓库已在本地初始化并提交（分支 `main`）。换成你的远程即可：

```powershell
cd H:\deepseek_harness\Meiju_English_learning_release
git remote add origin https://github.com/<用户名>/dsh-plugin-meiju-english.git
git push -u origin main
```

推送前确认：

```powershell
git status --short          # 应该只有源码，没有 data/ 或 verification/
git ls-files                # 应只列出 plugin/、tools/、docs/、README、LICENSE、package.json、.gitignore
```

## 2. 上架 DSH 插件市场

市场（`dshmarket`）只展示精选列表里的插件。上架 = 去
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库按它的模板提一个 PR，**加一条条目**（站点与该市场每天 CI 自动收录，通常 1 天内生效）。

条目字段参考（以该仓库当时的模板为准）：

```json
{
  "name": "meiju-english",
  "owner": "<用户名>",
  "url": "https://github.com/<用户名>/dsh-plugin-meiju-english",
  "category": "tools",
  "description": {
    "en": "Turn a US-TV episode plus bilingual .ass subtitles into trimmed listening audio, sentence clips, offline SenseVoice shadowing with word-level scoring, quizzes and a phone listening page. All processing stays local.",
    "zh": "把美剧视频和中英双语字幕变成去头尾音频、逐句片段、本地 SenseVoice 跟读评分、测试题和手机磨耳朵页面，全部在本机处理。"
  },
  "install": "dsh plugin --profile web add github:<用户名>/dsh-plugin-meiju-english",
  "icon": "https://raw.githubusercontent.com/<用户名>/dsh-plugin-meiju-english/main/plugin/icon.svg",
  "screenshots": [
    "https://raw.githubusercontent.com/<用户名>/dsh-plugin-meiju-english/main/docs/screenshots/main.png"
  ],
  "capabilities": ["shell", "fs-write", "fs-read", "network"]
}
```

`capabilities` 请如实保留：生成物料要 `spawn` ffmpeg（`shell`）、读本机视频/字幕（`fs-read`）、写数据目录（`fs-write`）、起局域网 HTTP 服务（`network`）。

### 截图

`docs/screenshots/` 里目前只有说明。上架前在 DSH 里截 4 张（列表页 / 详情 / 测试 / 跟读，浅色或深色），放进该目录再推一次。市场条目的 `screenshots` 用 raw 链接。

## 3. 可选：发布 npm

```powershell
cd H:\deepseek_harness\Meiju_English_learning_release
npm publish            # 首次需 npm login；包名冲突就改 package.json 的 name
```

发布后市场条目可把 `install` 改成 `dsh plugin --profile web add dsh-plugin-meiju-english`，并在条目里填 `"npm": "dsh-plugin-meiju-english"`。

> 注意：npm 包只包含 `plugin/`、`tools/`、`docs/`、README、LICENSE（见 `package.json` 的 `files`），数量级 < 1 MB，不含任何影视内容。

## 4. 发布前自检（每次发版）

```powershell
node --check plugin/index.js
node --check plugin/client.js
node --check tools/build_episode.mjs
node -e "JSON.parse(require('fs').readFileSync('package.json')); console.log('package.json ok')"
# 确认没有数据/个人路径混入
git ls-files | Select-String -Pattern 'data/|verification/|\.wav$|\.mp4$'
Select-String -Path README.md -Pattern 'H:\\|192\.168\.'
```

改版本号：`package.json` 的 `version` + `plugin/package.json` 的 `version` 一起加，然后 `git tag v1.0.1 && git push --tags`。

## 5. 验证安装（推荐在新 profile 里）

```powershell
dsh plugin --profile test add github:<用户名>/dsh-plugin-meiju-english
```

打开该 profile 的 DSH，确认侧边栏出现「美剧英语」、面板能加载。Host 端模块在 DSH 启动时加载，**装完 / 升级后要重启 DSH**。

## 不要提交的东西

- `data/`：本机生成的视频代理、音频、逐句片段、台词与题目（版权 + 体积，已在 `.gitignore`）
- `verification/`、日志、测试音频
- 任何影视画面、字幕文件、演员海报
