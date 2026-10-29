# dsh-constitution-seed

**Constitution-seed injector · 宪法种子注入器**

Seeds every new session with bounded excerpts — plus a manifest with file sizes and content hashes — of your workspace rule files (defaults: `SOUL.md`, `USER.md`, `IDENTITY.md`; `AGENTS.md` is listed in the manifest only, since the host already injects it).

**为什么需要它**：原生 `instructionFileCandidates` 按"整份文件"做预算——超预算就从第一份开始整个丢弃，多文件大总量场景下正文几乎全军覆没。本插件改为：每份文件各自有界、按序灌入、共享预算、尽头截断，并附哈希清单便于对账磁盘正本。

## 行为
- 注入为 **user 消息**（非 system prompt）——工作区内容没有系统级权威，消息自带"这是背景、不是任务"说明
- **幂等**：进程内按文件指纹(size+mtime)判重 + 按正文 sha256 扫描会话历史判重，resume 不重复注入；文件改动自动重推一次
- 单份超 `MAX_SOURCE_BYTES`(8MB) 只登记清单不灌摘录

## 配置
| 字段 | 默认 | 说明 |
|---|---|---|
| `files` | `['SOUL.md','USER.md','IDENTITY.md']` | 要整篇灌入（有界）的文件 |
| `manifest` | 四文件清单 | 只列哈希不灌正文的文件 |
| `perFileBytes` | `32768` | 单份摘录上限 |
| `totalBytes` | `131072` | 总预算（共享池） |
| `includeSubagents` | `false` | 子代理会话是否也注入 |

## 安装
```
dsh plugin add github:xushilianzhuren/dsh-constitution-seed
```
MIT License.
