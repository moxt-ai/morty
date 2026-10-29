<div align="center">

# Morty

[English](README.md) · **简体中文**

### 离开电脑，也能让工作继续。

在任意浏览器中，继续与 Codex、Claude Code 和 Pi 对话。

[打开 Morty →](https://morty.build) · [开始连接](#一条提示词然后拿起手机) · [参与贡献](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Built on Mobius](https://img.shields.io/badge/built_on-Mobius-111.svg)](https://github.com/moxt-ai/mobius)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

Agent 在电脑上工作，你可以用手机、平板或另一台电脑查看进展，给出下一条指令。
Morty 把正在进行的对话带到你手边。

## 工作进展，随时掌握

- **看见正在发生的事。** 实时查看回复和工具执行进展，打开对话中的文件和生成的图片。
- **让任务继续向前。** 发送指令、排队追加任务、停止当前执行，或响应 Agent 支持的审批请求。
- **换个屏幕，接着聊。** 从另一个浏览器回到已连接的对话，继续之前的工作。

## 你的 Agent，原来的环境。

项目、工具和已登录的 Agent 仍在连接的机器上，Morty 提供远程对话的浏览器界面。
换个屏幕，打开已连接的对话就能继续工作。需要协作时分享访问权限，用完后可以撤销。

## 一条提示词，然后拿起手机。

打开 [morty.build](https://morty.build) 复制设置提示词，或把下面的内容发给你的编程 Agent：

```text
Fetch https://morty.build/setup.md and set up Morty for me.
You may install missing prerequisites and pair this machine.
Complete setup without asking questions.
```

打开 Agent 返回的链接，或用手机扫描二维码。无需安装手机 App。

安装过程是一份你的 Agent 会读的文档，不是黑盒：
[setup.md](https://morty.build/setup.md) 完全公开，并且要求 Agent 把安装脚本下载到
私有临时目录、运行前先检查一遍。粘贴提示词之前，建议你自己也读一遍。

## 运行条件

- 电脑上装有并已登录 **Codex**、**Claude Code** 或 **Pi** 其中之一
- **Node.js 22.19.0 或更高版本**
- 连接的机器保持**唤醒并联网**。Morty 是你本地会话的一扇窗，不是云端沙箱；
  电脑休眠时会话随之暂停，重新连上之前浏览器里看不到历史
  （[#907](https://github.com/moxt-ai/morty/issues/907)）。

## 已知限制

- **在 Morty 里继续之前，先退出终端里的会话；回到电脑后，再重新恢复它。** 用
  `claude --resume`、`pi --continue` 或 `codex resume` 打开的终端会话里做的事，Morty
  都能接上。但一直开着没退出的终端会话保留的是它自己的那份对话：看不到你在 Morty 里发的
  消息，**Claude Code** 和 **Pi** 在那里发下一条消息时还会让对话分叉。
- **Codex 同一时间只允许一个应用写入同一个 thread。** 在 Morty 里用过某个 thread 之后，
  如果终端提示 `thread ... already has an active writer`，执行 `mobius release`。它会交还
  闲置的会话，不会断开 Morty；之后在 Morty 里继续时会重新打开。

## Morty 如何处理你的数据

- **对话是从你的机器实时读取的。** 浏览器只保存会话 ID 和标题，历史记录在每次打开
  会话时从你电脑上的 daemon 取回。电脑离线时，浏览器里看不到历史——这是设计如此，
  不是缓存没命中。
- **云端 Recording 是关闭的。** Mobius 为需要"机器离线后历史仍可访问"的应用提供可选的
  云端 Recording 能力。Morty 没有启用它：应用级策略将 Recording 设为 `disabled`，
  且没有任何 Morty 项目覆盖该设置。
- **Relay 负责传输，不是保险箱。** 会话流量经由 Mobius relay 到达你的机器。
  **Morty 不是端到端加密的**——在这个设计里，relay 是一个被信任的组件。
  如果端到端加密是你的硬性要求，Morty 目前不满足。
- **机器身份只留在本机。** 安装程序把这台电脑的 Morty 身份保存在当前用户的本地应用
  数据目录中，并用文件系统权限保护。它不会在电脑之间同步，每台电脑各有一份。
- **分享是显式的，也是可撤销的。** 分享链接会让持有者能够查看并操作该项目下的会话。
  要撤销此前从某台机器分享出去的全部链接，对你的 Agent 说：
  *"Revoke all links I previously shared from this machine."*

## 离开

Morty 不会扣住你的会话。执行 `mobius quit`，这台电脑上所有 Morty 会话都会关闭，
而配对关系和 Agent 自身的历史记录完整保留。回到原生客户端继续：

| Agent | 恢复会话 |
| --- | --- |
| Codex | `codex resume` |
| Claude Code | `claude --resume`，或用 `claude --continue` 直接接上最近一次 |
| Pi | `pi --resume`，或用 `pi --continue` 直接接上最近一次 |

之后执行 `mobius start` 即可重新连接 Morty。如果只想把闲置的会话交还给终端、
不断开 Morty，改用 `mobius release`。

## 安全

发现安全问题？请私下报告——见 [SECURITY.md](SECURITY.md)。
请不要为安全问题创建公开 issue。

---

基于 [**Mobius**](https://github.com/moxt-ai/mobius) 构建。
Mobius 为开发者提供远程连接编程 Agent 的 SDK 和基础设施，Morty 则是开箱即用的浏览器应用。

[参与贡献](docs/CONTRIBUTING.md) · [测试指南](docs/TESTING.md) · [使用指南](docs/GUIDE.md) · [部署说明](docs/deployment.md) · [安全](SECURITY.md)

## 许可

[Apache License 2.0](LICENSE)，另见 [NOTICE](NOTICE)。

"Morty"、"Moxt" 及其标识是 Moxt 的商标。Apache 2.0 授予你的是代码的权利，
不包括名称和标识——欢迎 fork，但请给它取一个自己的名字。
