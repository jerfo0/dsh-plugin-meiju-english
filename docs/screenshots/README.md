# 截图目录

上架 DSH 插件市场与写 README 时建议放 4 张真实界面截图（在 DSH 里打开「美剧英语」面板截取）：

| 文件名 | 内容 |
|---|---|
| `main.png` | 剧集列表：海报墙 + 每集 6 步进度 |
| `detail.png` | 单集详情：步骤卡 + 视频播放器 + 中英字幕 |
| `quiz.png` | 测试题（一题一屏 + 答对/解析状态） |
| `shadow.png` | 跟读练习：逐词绿/红 + 分数 + 识别文本 |

建议宽度 1600px、PNG、不超过 1 MB，浅色与深色主题各一张更佳（`main-light.png` / `main-dark.png`）。

仓库内不要提交任何影视画面或字幕内容的截图——只截插件自己的界面。

提交到市场时，用 raw 链接填进条目的 `screenshots` 字段，例如：

```
https://raw.githubusercontent.com/jerfo0/dsh-plugin-meiju-english/main/docs/screenshots/main.png
```
