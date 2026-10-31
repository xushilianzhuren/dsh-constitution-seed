# dsh-fire-seed · 火种注入器

把工作区常驻宪法文件的有界摘录注入每一个新会话，使新会话开局即知道这几份文件
存在、以及它们开头的规矩；完整原文留在磁盘，按需 `read` / `rg`。

## 它做什么

每个会话的第一步，在用户消息之后插入一条 `source.kind = 'fire-seed-instructions'`
的 user 消息，内容为：

1. 一份**清单**：四份文件的字节数 + 全文 sha256 前 12 位（可对账磁盘）；
2. 每份文件**开头 ≤ `perFileBytes` 字节**的摘录，附截断说明与原文件绝对路径。

消息自带"背景指令、不是任务、摘录不代表全文"的说明，且注入为 **user 消息而非
system prompt**——工作区内容没有系统级权威。

## 为什么不用原生 `instructionFileCandidates`

原生渲染器按**整份文件**做预算：超预算就从头弃，只允许截断最后一份。把
SOUL/USER/IDENTITY 一起塞进候选表，在 2.4MB 总量下它会丢掉 AGENTS/SOUL/USER、
只留截断的 IDENTITY——正好与需求相反。所以 AGENTS.md 继续走原生通道，本插件
负责另外三份的「每份都有、各自有界」。

## 幂等

- 进程内按「文件指纹（size + mtime）」判重，不变则不重推；
- 按正文 sha256 扫描会话历史判重，会话 resume 后不会重复注入；
- 文件改动后自动重推（一次）。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | 会话工作目录 | 宪法文件所在目录；配了就是固定根，跨工作区会话也注入 |
| `files` | `SOUL.md, USER.md, IDENTITY.md` | 需要摘录的文件 |
| `manifest` | 四份全列 | 清单里列出的文件（只列不摘录的会标注原因） |
| `perFileBytes` | `16384` | 单份摘录上限（UTF-8 字节） |
| `totalBytes` | `65536` | 本条消息总预算，含清单与框架 |
| `includeSubagents` | `false` | 是否也给子会话注入（默认不给，省 token） |
| `enabled` | `true` | 总开关 |

## 语义边界（已知取舍）

- 摘录 ≠ 读过全文。四份文件合计约 2.4MB，任何上下文窗口都放不下，因此**只能
  注入开头**；条款级细节必须回磁盘 `rg`。
- 注入是**追加**，不替代原生 AGENTS.md 通道，两者并存。
- 关掉：`plugin_manager` 里把 `fire-seed` 行 disable，或 `config.enabled: false`。
