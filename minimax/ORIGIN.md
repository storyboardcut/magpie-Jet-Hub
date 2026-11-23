# 这个目录是什么

[\`@magpie-community/opencode-minimax-auth\`](https://www.npmjs.com/package/@magpie-community/opencode-minimax-auth)
**0.2.9** 的原样副本（MIT，作者 yetone，仓库 [magpie-community/plugins](https://github.com/magpie-community/plugins)）。

放在本仓库里是为了**不依赖 npm 存活**：上游哪天停更或下架，这里还有一份能装。

## 它提供什么

- 两个聊天 provider：\`minimax-code\`（中国站）/ \`minimax-code-global\`（国际站）
- 19 个 MiniMax 工具：图像生成、视频生成、图片搜索、语音合成、音乐、多模态理解等
- 登录后可当 Magpie 内置「图像 / 视频 / Web 搜索」的后端

## 与仓库根目录（Jet Hub）的关系

两者**互不干扰**，可以同时安装：

| | 根目录 magpie-supermarket | minimax/ |
|---|---|---|
| 渠道 | 31 家 AI 编码渠道 | MiniMax 两站 |
| 多媒体 | 无 | 图像 / 视频 / 语音 / 音乐 |
| 来源 | 跟进上游 dsh-providers-hub | npm 上的社区插件 |

## 怎么装

\`\`\`
magpie plugin add "https://github.com/storyboardcut/magpie-supermarket/tree/main/minimax"
\`\`\`

（或继续用 npm 那份，两者内容一致。）

## 怎么更新

\`\`\`
npm pack @magpie-community/opencode-minimax-auth --registry=https://registry.npmmirror.com
# 解压后把这 10 个文件整体替换到 minimax/ 即可
\`\`\`

## 注意

README 里上游自己写明：MiniMax **未批准**跨代理使用额度，账号有被限制的风险。
国际站需要中国大陆以外的网络，否则会被重定向回中国站、令牌不互通。
