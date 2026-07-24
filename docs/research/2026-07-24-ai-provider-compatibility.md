# 腾讯 TokenHub 与阿里 DashScope 兼容性评估

**日期：** 2026-07-24
**范围：** 现有 `src/lib/ai.server.ts` 的 OpenAI-compatible Chat Completions 调用
**决策：** 腾讯 TokenHub 主用，阿里 DashScope 人工备用；不做自动 fallback

## 结论

现有实现已使用标准 `POST`、Bearer 鉴权、`model`、`messages` 和
`choices[0].message.content`，可以在不引入 SDK 或供应商适配层的前提下
支持两家服务。最小改动是把完整 chat-completions URL、model 和可选
`enable_thinking` 变成受限的运行时配置。

供应商切换必须是人工替换一组静态配置并重启服务。不能在 generic 配置不完整
时回退到 DeepSeek，否则可能把一个供应商的 credential 发给另一个供应商。

## 官方资料确认

### 腾讯 TokenHub

- TokenHub 按地域提供 HTTPS endpoint；广州默认域名为
  `https://tokenhub.tencentmaas.com`，并明确要求按开通地域调用。
- `/v1/models` 使用 `Authorization: Bearer <API KEY>`，返回的模型 ID 是推理
  请求应使用的 `model` 值。当前官方列表包含 `qwen3.5-flash`。
- Qwen 指南给出的 OpenAI-compatible 请求路径是
  `/v1/chat/completions`；`enable_thinking` 是请求 JSON 的顶层布尔字段。

来源：[TokenHub API 使用说明](https://cloud.tencent.com/document/product/1823/130078)、
[Qwen 调用指南](https://cloud.tencent.com/document/product/1823/132247)。

### 阿里 DashScope

- DashScope 原生 API 文档使用 Bearer 鉴权，并以 `qwen-plus` 展示文本生成。
- OpenAI-compatible endpoint 与原生 DashScope endpoint 不同。北京共享
  OpenAI-compatible base URL 是
  `https://dashscope.aliyuncs.com/compatible-mode/v1`，因此本项目需要配置
  完整 URL
  `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`。
- endpoint、API key 的 region/workspace 必须匹配。Token Plan/Coding Plan
  面向交互式编码工具，不应用作本服务的后端 credential。

来源：[DashScope API Reference](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope)、
[Base URL overview](https://help.aliyun.com/en/model-studio/base-url)。

## 已知实测事实

以下是任务提供的真实安全 smoke 结果，本次实现未读取或输出 credential，也未
重复调用线上服务：

| 供应商         | 模型            | 结果                      |
| -------------- | --------------- | ------------------------- |
| 腾讯 TokenHub  | `qwen3.5-flash` | HTTP 200、JSON、约 821 ms |
| 阿里 DashScope | `qwen-plus`     | HTTP 200、JSON、约 878 ms |

这些结果只证明当时的基础 chat-completions 链路可达，不等于生产 SLA，也不
证明所有模型都支持现有 `response_format: {"type":"json_object"}`。学员 JSON
回答路径仍应在正式发布前做一次不含敏感信息的真实 smoke。

## 最小复用方案

| 项目     | 腾讯主用                                               | 阿里人工备用                                                         |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| 完整 URL | `https://tokenhub.tencentmaas.com/v1/chat/completions` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| model    | `qwen3.5-flash`                                        | `qwen-plus`                                                          |
| thinking | 显式 `false`                                           | 按所选模型显式 `false` 或不配置                                      |
| 切换     | 修改完整配置组、重启、smoke                            | 修改完整配置组、重启、smoke                                          |

实现边界：

- generic 配置必须同时包含 key、完整 HTTPS URL 和 model；
- URL 禁止 userinfo，避免 credential 被嵌入或意外转发；
- provider 重定向一律拒绝，避免初始 HTTPS endpoint 把服务器请求转向第二地址；
- `enable_thinking` 只接受 `true`/`false`，不开放任意 `extra_body`；
- 完整 generic 配置优先；仅在完全没有 generic 配置时兼容旧
  `DEEPSEEK_API_KEY`；
- provider response body、URL 和 credential 不进入异常或日志；
- 不增加 SDK、自动 fallback、动态路由、重试切换或双写。

## 风险与发布检查

1. 上线前用 TokenHub `/v1/models` 确认目标模型仍可用且 ID 未变化。
2. 用服务器实际 region/workspace 对应的 credential，避免跨地域配置。
3. 分别 smoke 普通草稿和 JSON 学员回答；失败日志只能出现固定内部 code。
4. 人工切换到 DashScope 后必须重启并重跑 smoke，不能把基础 200 当成全路径
   验收。
5. AI 故障不得影响人工导师、时间线、MCP 或 WorkBuddy 投递闭环。

## ADR 草案

- **Context：** 固定 DeepSeek endpoint/model 无法部署已验证的 TokenHub，也
  无法人工切换 DashScope。
- **Options：** 引入供应商 SDK；实现双供应商自动路由；复用现有 fetch 并使用
  一组受限的静态运行时配置。
- **Decision：** 选择第三种。腾讯为主用，阿里为人工备用，旧 DeepSeek
  credential 只用于向后兼容。
- **Consequences：** 改动面和依赖最小，credential 边界清晰；代价是切换需要
  运维改配置、重启和 smoke，且没有自动容灾。

## 参考来源

1. [腾讯云 TokenHub API 使用说明](https://cloud.tencent.com/document/product/1823/130078)
2. [腾讯云 Qwen 调用指南](https://cloud.tencent.com/document/product/1823/132247)
3. [阿里云 DashScope API Reference](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope)
4. [阿里云 Model Studio Base URL overview](https://help.aliyun.com/en/model-studio/base-url)
