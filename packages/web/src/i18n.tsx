import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "zh";

const STORAGE_KEY = "agentshare_lang";

export function getInitialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return "en";
}

export const translations = {
  en: {
    // Header & Auth Modal
    searchPlaceholder: "Search packs…",
    searchBtn: "Search",
    publishNav: "Publish",
    accountAndToken: "Account & Access Token",
    tokenCopiedTitle: "Access token copied",
    copyTokenTitle: "Copy access token",
    signOut: "Sign Out",
    signIn: "Sign In",
    authModalTitle: "🔑 Account & Access Token",
    authModalDesc:
      "Manage your account session, organization memberships, and personal access token for CLI publishing and sandbox execution.",
    signedInAs: "Signed in as",
    copiedShort: "✓ Copied",
    copyTokenBtn: "Copy Token",
    orgsLabel: "Orgs:",
    orgsNone: "none",
    federationPeersLabel: "Federation Peers:",
    signInRegisterTab: "Sign In / Register",
    useAccessTokenTab: "Use Access Token",
    createAccount: "Create Account",
    usernamePlaceholder: "Username (e.g. alice)",
    passwordPlaceholder: "Password (min 4 characters)",
    signingInBusy: "Signing in…",
    pasteTokenPlaceholder: "Paste personal access token",
    verifyingBusy: "Verifying…",
    saveAccessToken: "Save Access Token",
    errCredentialsRequired: "Username and password are required.",
    errPasteValidToken: "Please paste a valid Bearer token.",
    errInvalidToken: "Invalid access token.",
    loadingCatalog: "loading…",
    emptyCatalog: "no packs yet — publish one with the CLI",
    langToggleLabel: "🌐 中文",
    langToggleTitle: "Switch to Chinese (切换到中文)",

    // Modes & Badges
    mode_offline: "OFFLINE",
    mode_endpoint: "ENDPOINT",
    mode_runtime: "RUNTIME",
    modeOffline: "offline",
    modeEndpoint: "endpoint",
    modeRuntime: "runtime",
    roleOwner: "owner",
    roleAdmin: "admin",
    roleMember: "member",
    roleViewer: "viewer",
    downloadsSuffix: "downloads",
    unverifiedPill: "unverified",
    universalHarness: "Universal",
    projectCheckboxTitle: "Install into current project .agents/ instead of global",
    projectCheckboxLabel: "Project local (--project)",
    copyBtn: "Copy",
    copiedBtn: "Copied!",
    copyCodeTitle: "Copy code",

    // PackDetail
    backToCatalog: "← Back to Catalog",
    backToCatalogLower: "← back to catalog",
    loadingPackSpec: "loading pack specification…",
    star: "Star",
    starred: "Starred",
    starFailedPrefix: "Star failed:",
    downloadTgz: "Download .tgz",
    tabSkillDoc: "📄 Documentation (SKILL.md)",
    tabSkillReady: "Ready",
    tabTopology: "⎇ Dependency & Harness Topology",
    tabTopologyVisual: "Visual",
    tabPlayground: "⚡ Sandbox Playground",
    tabPlaygroundBadge: "Sandbox",
    tabManifestSecurity: "⚙ Manifest & Security",
    skillCardTitle: "Documentation (SKILL.md)",
    skillRenderBadge: "Live Markdown",
    parsingSkillMd: "Parsing SKILL.md from pack tarball…",
    emptySkillMdTitle: "No SKILL.md was found at the root of this pack.",
    emptySkillMdSub: "Skills can also be declared in subdirectories listed in agent.json.",
    distAttributesTitle: "Distribution Attributes",
    metaDownloads: "Downloads",
    metaStars: "Stars",
    metaAvailableVersions: "Available Versions",
    metaPackageSize: "Package Size",
    metaSha256Digest: "SHA256 Digest",
    securityVerificationTitle: "Harness & Security Verification",
    metaCompatibleHarnesses: "Compatible Harnesses",
    metaMode: "Mode",
    metaA2aEndpoint: "A2A Endpoint",
    metaMcpConfig: "MCP Config",
    metaRequiredSecrets: "Required Secrets",
    metaSignature: "Ed25519 Signature",
    signatureVerified: "VERIFIED",
    signatureUnsigned: "Unsigned",

    // DependencyTopology
    topologyTitle: "Dependency & Harness Topology",
    topologyHint: "Click nodes to inspect runtime bindings",
    topoAgentPack: "AGENT PACK",
    topoSupportedHarnesses: "COMPATIBLE HARNESSES",
    topoPromptSkills: "PROMPT SKILLS & INSTRUCTIONS",
    topoSkillRoot: "SKILL.md (Root)",
    topoToolIntegration: "TOOL INTEGRATION",
    topoNoExternalTools: "No external tools required (Pure prompt skill)",
    topoDeclarativeSecrets: "DECLARATIVE SECRETS",
    topoZeroCredentials: "Zero credentials required (Zero-trust safe)",
    inspectorRootTitle: "Root Pack Manifest",
    inspectorDigest: "Digest",
    inspectorSize: "Size",
    inspectorBytes: "bytes",
    inspectorCreated: "Created",
    inspectorHarnessTitle: "Harness Compatibility",
    inspectorHarnessDescPrefix: "This skill pack is verified to execute within the",
    inspectorHarnessDescSuffix: "coding agent runtime.",
    inspectorSkillTitle: "Skill Definition",
    inspectorSkillDesc: "Standardized prompt instructions packaged according to agent-pack/v0.",
    inspectorMcpTitle: "Model Context Protocol (MCP) Server",
    inspectorMcpDescPrefix: "Configured in",
    inspectorMcpDescSuffix: "Tools are sandboxed with read-only guards.",
    inspectorEndpointTitle: "Remote A2A Endpoint",
    inspectorEndpointDescPrefix: "Bound to remote endpoint:",
    inspectorSecretTitle: "Declared Environment Secret",
    inspectorSecretDesc:
      "Host agent will prompt for this environment variable upon installation or inherit safely.",

    // PlaygroundView
    playgroundTitle: "⚡ Sandbox Playground",
    playgroundBadge: "🛡️ Isolated Node/Wasm Subprocess",
    playgroundSubtitle:
      "Test this pack directly in an ephemeral sandbox without local installation.",
    presetPrompt: "Prompt Preset",
    presetJson: "JSON Tool Call",
    defaultRuntimeQuery: "Hello from AgentShare Playground",
    defaultSkillPromptPrefix: "Please execute the ",
    defaultSkillPromptSuffix: " skill for a project security audit.",
    presetAuditPromptText:
      "Review the following authentication logic for timing attacks and token leaks.",
    noOutputFallback: "(no output)",
    signInSandboxBanner: "🔒 Sign in to execute packs in the isolated cloud sandbox.",
    taskPromptLabel: "Task Prompt (Text prompt or JSON):",
    runningInSandbox: "Running in Sandbox…",
    runInSandbox: "⚡ Run in Sandbox",
    executionErrorLabel: "Execution Error:",
    statusSuccess: "✓ SUCCESS",
    statusFailed: "✗ FAILED",
    exitCodeLabel: "Exit Code:",
    hideConsoleLogs: "Hide Console Logs",
    showConsoleLogs: "Show Console Logs",
    outputResultLabel: "Output Result:",
    executionTraceLabel: "Execution Trace:",
    errSignInToRun: "Please sign in to run packs in the sandbox.",
    sandboxIdleStatus: "READY",
    sandboxIdleHint: "$ Ready — click 'Run in Sandbox' to stream isolated execution trace & output...",

    // PublishPage
    backLink: "← back",
    publishTitle: "Publish a pack",
    publishImmutableLead: "Releases are immutable — bump",
    publishImmutableMid: "in",
    publishImmutableTail: "to publish again.",
    publishStep1Title: "Build the tarball",
    publishStep1DescLead: "The registry re-validates",
    publishStep1DescTail: ", re-runs the security scan, and blocks high-severity packs.",
    publishStep2Title: "Upload",
    dropzoneEmptyTitle: "Drop a pack tarball here",
    dropzoneEmptySub: "or click to choose a .tgz file",
    publishStep3Title: "Authenticate & publish",
    publishSignedInLead: "Signed in as",
    publishSignedInTail: "— token not required.",
    apiTokenLabel: "API token",
    optionalSuffix: " (optional)",
    tokenPlaceholder: "token from AGENTSHARE_TOKENS",
    tokenHintSignedIn:
      "Only needed to publish under a different owner; otherwise this browser session is used.",
    tokenHintSignedOut:
      "Stored in this browser only; sent to this registry as a Bearer token.",
    publishedBadge: "published",
    viewPackLink: "view pack",
    publishingBusy: "publishing…",
    publishSubmitBtn: "publish",
    copyLower: "copy",
    copiedLower: "copied",
    errAgentJsonNotFound: "agent.json not found in the tarball",
    errAgentJsonInvalid: "agent.json is not valid JSON",
    errAgentJsonMustBeObject: "agent.json must be an object",
    errAgentJsonMissingFieldPrefix: "agent.json is missing",
    errChooseTarballFirst: "choose a tarball created by `agentshare pack` first",
    errTokenRequired: "API token is required (or sign in via this registry's OIDC login)",
    skillsCountSuffix: "skills",

    // SharePage
    shareRevoked: "This share has been revoked.",
    shareEndpointPrefix: "You are talking to a remote agent over A2A",
    shareOnlineDesc: "You are talking to a live agent session on the owner's machine. Read-only.",
    shareOfflineDesc: "The owner is offline. The link works again when their agent is sharing.",
    shareStatus_online: "online",
    shareStatus_offline: "offline",
    shareStatus_revoked: "revoked",
    roleVisitor: "Visitor",
    roleAgent: "Agent",
    roleSystem: "System",
    submittedPrefix: "Submitted #",
    submittedNoSessionHint: " (send a message in the chat to receive updates)",
    handoffContextPrefix: "📋 Handoff Context",
    handoffOpenTasksSuffix: "open tasks",
    handoffComplete: "complete",
    handoffDoneWhen: "Done when:",
    handoffTasksTitle: "Progress & Tasks",
    handoffBlocked: " (blocked)",
    handoffVerify: "Verify:",
    handoffDecisionsTitle: "Key Decisions",
    handoffSourcesTitle: "Context Sources",
    handoffOutcomesTitle: "Outcomes",
    handoffAuthTitle: "Authorizations (Not Auto-Inherited)",
    authInherited: "Inherited",
    authReauthorize: "Reauthorize",
    authUnavailable: "Unavailable",
    handoffConstraintsTitle: "Constraints & Environment",
    handoffQuestionsTitle: "Open Questions",
    handoffFooterNote:
      "Sources are unverified and permissions are not automatically inherited. Ask below about the rationale behind any decision.",
    chatEmpty: "No messages yet — start a session to converse with this agent.",
    yourNamePlaceholder: "your name",
    offlinePlaceholder: "offline",
    askAgentPlaceholder: "ask the agent…",
    sendBtn: "send",
    submitOutcomeSummary: "Submit Outcome",
    submitSummaryPlaceholder: "What did you accomplish in this continuation?",
    submitChangesPlaceholder: "Changes made, one per line (optional)",
    submitQuestionsPlaceholder: "Open questions, one per line (optional)",
    submittingBtn: "Submitting…",
    submitBtn: "Submit",
  },
  zh: {
    // Header & Auth Modal
    searchPlaceholder: "搜索技能包…",
    searchBtn: "搜索",
    publishNav: "发布",
    accountAndToken: "账户与访问令牌",
    tokenCopiedTitle: "访问令牌已复制",
    copyTokenTitle: "复制访问令牌",
    signOut: "退出登录",
    signIn: "登录",
    authModalTitle: "🔑 账户与访问令牌",
    authModalDesc:
      "管理您的账户会话、组织成员身份以及用于 CLI 发布和沙箱执行的个人访问令牌。",
    signedInAs: "当前登录账户",
    copiedShort: "✓ 已复制",
    copyTokenBtn: "复制令牌",
    orgsLabel: "所属组织:",
    orgsNone: "无",
    federationPeersLabel: "联邦节点:",
    signInRegisterTab: "账号登录 / 注册",
    useAccessTokenTab: "使用访问令牌",
    createAccount: "创建账户",
    usernamePlaceholder: "用户名 (例如 alice)",
    passwordPlaceholder: "密码 (至少 4 位字符)",
    signingInBusy: "正在登录…",
    pasteTokenPlaceholder: "粘贴个人访问令牌",
    verifyingBusy: "正在验证…",
    saveAccessToken: "保存访问令牌",
    errCredentialsRequired: "请输入用户名和密码。",
    errPasteValidToken: "请粘贴有效的访问令牌。",
    errInvalidToken: "无效的访问令牌。",
    loadingCatalog: "加载中…",
    emptyCatalog: "暂无技能包 — 可通过 CLI 或发布页面上传",
    langToggleLabel: "🌐 EN",
    langToggleTitle: "切换到英文 (Switch to English)",

    // Modes & Badges
    mode_offline: "离线可用",
    mode_endpoint: "远程端点",
    mode_runtime: "沙箱运行时",
    modeOffline: "离线可用",
    modeEndpoint: "远程端点",
    modeRuntime: "沙箱运行时",
    roleOwner: "所有者",
    roleAdmin: "管理员",
    roleMember: "成员",
    roleViewer: "只读成员",
    downloadsSuffix: "次下载",
    unverifiedPill: "未验证",
    universalHarness: "通用全宿主",
    projectCheckboxTitle: "安装到当前项目的 .agents/ 目录而非全局目录",
    projectCheckboxLabel: "项目本地安装 (--project)",
    copyBtn: "复制",
    copiedBtn: "已复制!",
    copyCodeTitle: "复制代码",

    // PackDetail
    backToCatalog: "← 返回技能目录",
    backToCatalogLower: "← 返回技能目录",
    loadingPackSpec: "正在加载技能包规范…",
    star: "星标",
    starred: "已星标",
    starFailedPrefix: "星标操作失败：",
    downloadTgz: "下载 .tgz",
    tabSkillDoc: "📄 技能文档 (SKILL.md)",
    tabSkillReady: "就绪",
    tabTopology: "⎇ 依赖与宿主拓扑",
    tabTopologyVisual: "可视化",
    tabPlayground: "⚡ 沙箱演练场",
    tabPlaygroundBadge: "沙箱",
    tabManifestSecurity: "⚙ 清单与安全校验",
    skillCardTitle: "技能文档 (SKILL.md)",
    skillRenderBadge: "实时渲染",
    parsingSkillMd: "正在从技能包归档中解析 SKILL.md…",
    emptySkillMdTitle: "在此技能包根目录中未找到 SKILL.md。",
    emptySkillMdSub: "技能也可以声明在 agent.json 所列的子目录中。",
    distAttributesTitle: "分发属性",
    metaDownloads: "下载次数",
    metaStars: "星标数",
    metaAvailableVersions: "可用版本",
    metaPackageSize: "包体积",
    metaSha256Digest: "SHA256 摘要",
    securityVerificationTitle: "宿主兼容与安全校验",
    metaCompatibleHarnesses: "兼容宿主环境",
    metaMode: "运行模式",
    metaA2aEndpoint: "A2A 远程端点",
    metaMcpConfig: "MCP 配置",
    metaRequiredSecrets: "所需密钥",
    metaSignature: "Ed25519 签名验证",
    signatureVerified: "已签名验证",
    signatureUnsigned: "未签名",

    // DependencyTopology
    topologyTitle: "依赖与宿主拓扑",
    topologyHint: "点击节点查看运行时绑定详情",
    topoAgentPack: "技能包核心",
    topoSupportedHarnesses: "兼容宿主环境",
    topoPromptSkills: "提示词技能与指令",
    topoSkillRoot: "SKILL.md (根目录)",
    topoToolIntegration: "工具集成",
    topoNoExternalTools: "无需外部工具 (纯提示词技能)",
    topoDeclarativeSecrets: "声明式密钥",
    topoZeroCredentials: "无需凭证密钥 (零信任安全)",
    inspectorRootTitle: "根技能包清单",
    inspectorDigest: "摘要",
    inspectorSize: "大小",
    inspectorBytes: "字节",
    inspectorCreated: "创建时间",
    inspectorHarnessTitle: "宿主环境兼容",
    inspectorHarnessDescPrefix: "此技能包已通过验证，可在",
    inspectorHarnessDescSuffix: "智能体宿主环境中运行。",
    inspectorSkillTitle: "技能定义",
    inspectorSkillDesc: "遵循 agent-pack/v0 标准封装的提示词指令集。",
    inspectorMcpTitle: "模型上下文协议 (MCP) 服务",
    inspectorMcpDescPrefix: "配置于",
    inspectorMcpDescSuffix: "工具在只读安全沙箱中受控运行。",
    inspectorEndpointTitle: "远程 A2A 端点",
    inspectorEndpointDescPrefix: "绑定至远程端点：",
    inspectorSecretTitle: "声明的环境变量密钥",
    inspectorSecretDesc: "宿主智能体将在安装时提示配置此环境变量或安全继承。",

    // PlaygroundView
    playgroundTitle: "⚡ 沙箱演练场",
    playgroundBadge: "🛡️ 隔离式 Node/Wasm 子进程",
    playgroundSubtitle: "无需本地安装，直接在临时隔离沙箱中测试此技能包。",
    presetPrompt: "提示词预设",
    presetJson: "JSON 工具调用",
    defaultRuntimeQuery: "来自 AgentShare 演练场的测试请求",
    defaultSkillPromptPrefix: "请执行 ",
    defaultSkillPromptSuffix: " 技能以进行项目安全审计。",
    presetAuditPromptText: "请审查以下身份验证逻辑是否存在时序攻击与令牌泄露风险。",
    noOutputFallback: "（无输出）",
    signInSandboxBanner: "🔒 请先登录以在隔离云沙箱中运行技能包。",
    taskPromptLabel: "任务指令 (文本提示词或 JSON):",
    runningInSandbox: "沙箱运行中…",
    runInSandbox: "⚡ 在沙箱中运行",
    executionErrorLabel: "执行错误:",
    statusSuccess: "✓ 执行成功",
    statusFailed: "✗ 执行失败",
    exitCodeLabel: "退出码:",
    hideConsoleLogs: "隐藏控制台日志",
    showConsoleLogs: "显示控制台日志",
    outputResultLabel: "输出结果:",
    executionTraceLabel: "执行轨迹:",
    errSignInToRun: "请先登录以在沙箱中运行技能包。",
    sandboxIdleStatus: "就绪",
    sandboxIdleHint: "$ 就绪 — 点击「在沙箱中运行」以查看隔离执行轨迹与输出结果...",

    // PublishPage
    backLink: "← 返回",
    publishTitle: "发布技能包",
    publishImmutableLead: "发布的版本不可篡改 — 如需再次发布，请升级",
    publishImmutableMid: "中的",
    publishImmutableTail: "版本号。",
    publishStep1Title: "构建技能包归档",
    publishStep1DescLead: "注册中心会重新校验",
    publishStep1DescTail: "，重新执行安全扫描，并拦截高风险技能包。",
    publishStep2Title: "上传归档包",
    dropzoneEmptyTitle: "将技能包 .tgz 拖拽至此",
    dropzoneEmptySub: "或点击选择 .tgz 文件",
    publishStep3Title: "身份验证与发布",
    publishSignedInLead: "当前已登录为",
    publishSignedInTail: "— 无需额外填写令牌。",
    apiTokenLabel: "API 访问令牌",
    optionalSuffix: " (可选)",
    tokenPlaceholder: "来自 AGENTSHARE_TOKENS 的令牌",
    tokenHintSignedIn: "仅在需要使用其他所有者身份发布时填写；默认使用当前浏览器登录会话。",
    tokenHintSignedOut: "仅保存在当前浏览器中，作为 Bearer 令牌发送给注册中心。",
    publishedBadge: "已发布",
    viewPackLink: "查看技能包",
    publishingBusy: "正在发布…",
    publishSubmitBtn: "立即发布",
    copyLower: "复制",
    copiedLower: "已复制",
    errAgentJsonNotFound: "归档包中未找到 agent.json",
    errAgentJsonInvalid: "agent.json 不是有效的 JSON",
    errAgentJsonMustBeObject: "agent.json 必须是 JSON 对象",
    errAgentJsonMissingFieldPrefix: "agent.json 缺少必填字段",
    errChooseTarballFirst: "请先选择由 `agentshare pack` 生成的 .tgz 归档包",
    errTokenRequired: "需要填写 API 访问令牌（或先登录账户）",
    skillsCountSuffix: "个技能",

    // SharePage
    shareRevoked: "此共享会话已被撤销。",
    shareEndpointPrefix: "您正在通过 A2A 协议与远程智能体对话",
    shareOnlineDesc: "您正在与所有者机器上的实时智能体会话交互（只读模式）。",
    shareOfflineDesc: "所有者当前离线。当其智能体重新开启共享时链接将恢复可用。",
    shareStatus_online: "在线",
    shareStatus_offline: "离线",
    shareStatus_revoked: "已撤销",
    roleVisitor: "访客",
    roleAgent: "智能体",
    roleSystem: "系统",
    submittedPrefix: "已提交 #",
    submittedNoSessionHint: "（在聊天中发送消息以接收后续更新）",
    handoffContextPrefix: "📋 交接上下文",
    handoffOpenTasksSuffix: "项待办任务",
    handoffComplete: "已完成",
    handoffDoneWhen: "完成标准：",
    handoffTasksTitle: "进度与待办",
    handoffBlocked: "（阻塞）",
    handoffVerify: "验证：",
    handoffDecisionsTitle: "关键决策",
    handoffSourcesTitle: "资料来源",
    handoffOutcomesTitle: "成果",
    handoffAuthTitle: "授权（不会自动继承）",
    authInherited: "可继承",
    authReauthorize: "需重新授权",
    authUnavailable: "不可用",
    handoffConstraintsTitle: "约束与环境",
    handoffQuestionsTitle: "待解决问题",
    handoffFooterNote: "资料来源未经过验证；权限不会自动继承。可以在下面追问某个决策的依据。",
    chatEmpty: "暂无消息 — 发送消息开始与此智能体对话。",
    yourNamePlaceholder: "您的称呼",
    offlinePlaceholder: "当前离线",
    askAgentPlaceholder: "向智能体提问…",
    sendBtn: "发送",
    submitOutcomeSummary: "提交成果",
    submitSummaryPlaceholder: "这次续做完成了什么？",
    submitChangesPlaceholder: "变更说明，每行一条（可选）",
    submitQuestionsPlaceholder: "未解决的问题，每行一条（可选）",
    submittingBtn: "提交中…",
    submitBtn: "提交",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

const DYNAMIC_PAIRS: ReadonlyArray<[string, string]> = [
  // Seeded pack titles
  ["Flow Ecosystem Orchestrator", "Flow 生态编排器"],
  ["Release Helper", "发布助手"],
  ["Hello Handoff", "项目交接助手"],
  // Seeded pack descriptions
  [
    "Multi-service health diagnostics, release readiness checks, and cross-project workflow automation pack.",
    "多服务健康诊断、发布就绪检查与跨项目工作流自动化技能包。",
  ],
  [
    "Two-skill pack for shipping: turn merged changes into a Keep a Changelog entry, and write a PR description that leads with the problem and the verified checks. Demonstrates a multi-skill pack layout.",
    "面向版本发布的双技能包：将合并变更整理为 Keep a Changelog 规范条目，并生成以问题背景与验证结果为核心的 PR 描述。展示多技能包目录结构。",
  ],
  [
    "Minimal handoff agent pack. Answers project questions from bundled notes so teammates can ask the agent instead of interrupting the owner. Use as a demo and as a template for real handoff packs.",
    "轻量级项目交接智能体技能包。基于内置交接笔记回答项目问题，让团队成员无需打扰原负责人即可快速上手。可作为演示与真实交接包的模板。",
  ],
  ["Minimal handoff agent pack.", "轻量级项目交接智能体技能包。"],
  // Seeded pack tags
  ["flow", "工作流"],
  ["orchestrator", "编排器"],
  ["orchestration", "服务编排"],
  ["devops", "运维自动化"],
  ["security", "安全审计"],
  ["release", "版本发布"],
  ["changelog", "变更日志"],
  ["pull-request", "合并请求"],
  ["example", "示例"],
  ["handoff", "项目交接"],
  ["demo", "演示"],
  ["onboarding", "新人上手"],
  ["automation", "自动化"],
  ["audit", "审计"],
  // Seeded SKILL.md documents
  [
    `---
name: flow-orchestrator
description: Multi-service health diagnostics, release readiness checks, and cross-project workflow automation pack.
---

# Flow Ecosystem Orchestrator

Coordinate release pipelines, health checks, and cross-service workflows across your workspace with deterministic verification steps.

## Core Capabilities

- **Service Health Matrix**: Probes registered services and verifies readiness probes in parallel.
- **Release Gate Validation**: Confirms lockfile integrity, test suite status, and Ed25519 package signatures before deployment.
- **Cross-Harness Portability**: Installs cleanly into Claude Code, Codex, OpenCode, OpenClaw, and Hermes.

## Quick Start

\`\`\`bash
npx @agentshare/cli install mcocdaa/flow-orchestrator --target claude
\`\`\``,
    `---
name: flow-orchestrator
description: 多服务健康诊断、发布就绪检查与跨项目工作流自动化技能包。
---

# Flow 生态编排器 (Flow Ecosystem Orchestrator)

通过确定性的校验步骤，在工作区中协同调度发布流水线、健康检查与跨服务工作流。

## 核心能力

- **服务健康矩阵**：并行探测已注册服务并校验就绪探针状态。
- **发布门禁校验**：在部署前验证锁文件完整性、测试套件状态以及 Ed25519 归档包签名。
- **跨宿主可移植性**：支持一键安装至 Claude Code、Codex、OpenCode、OpenClaw 与 Hermes。

## 快速开始

\`\`\`bash
npx @agentshare/cli install mcocdaa/flow-orchestrator --target claude
\`\`\``,
  ],
  [
    `---
name: changelog
description: Turn merged changes into a Keep a Changelog style entry. Use when preparing a release, writing a CHANGELOG section, or summarizing what changed since the last tag.
---

# Changelog

Draft the next release section from the changes the user provides or the current range (\`git log <last-tag>..HEAD --oneline --no-merges\`).

## Workflow

1. Collect the commits or diffs for the range. If the last tag is unknown, ask for it instead of guessing.
2. Group entries under \`Added\` / \`Changed\` / \`Fixed\` / \`Removed\`; drop internal-only churn (CI, formatting, refactors) unless it affects users.
3. One line per user-visible change: imperative mood, present tense, name the surface (CLI, registry, Web, plugin).
4. Reference issue or PR numbers only when they appear in the input; never invent them.
5. Output only the new version section, ready to paste above the previous one.

## Example

\`\`\`markdown
## [0.2.0] - 2026-09-18

### Added

- \`agentshare export\` writes pack skills as plain SKILL.md directories.
- \`agentshare diff <from> <to>\` with added/removed/changed file counts.

### Fixed

- \`install --force\` now replaces a changed signer instead of skipping.
\`\`\`

## What not to do

- Do not invent dates, issue numbers, or contributors.
- Do not rewrite older sections; changelogs are append-only.`,
    `---
name: changelog
description: 将合并后的代码变更整理为 Keep a Changelog 规范条目。适用于准备版本发布、编写 CHANGELOG 章节或汇总自上个标签以来的变更。
---

# 变更日志生成 (Changelog)

根据用户提供的变更或当前 Git 范围（\`git log <last-tag>..HEAD --oneline --no-merges\`）起草下一个版本的变更日志章节。

## 工作流

1. 收集目标范围内的提交记录或差异对比；若未知上个版本标签，请先询问而非猜测。
2. 按 \`Added\` / \`Changed\` / \`Fixed\` / \`Removed\` 分组整理条目；剔除不影响用户的内部改动（CI、格式化、纯重构）。
3. 每项用户可见变更保持单行：采用祈使语气并注明涉及模块（CLI、registry、Web、plugin）。
4. 仅在输入中明确出现时引用 Issue 或 PR 编号，切勿虚构。
5. 仅输出可直接粘贴到旧版本上方的新版本章节。

## 示例

\`\`\`markdown
## [0.2.0] - 2026-09-18

### Added

- \`agentshare export\` 支持将技能包导出为纯 SKILL.md 目录结构。
- \`agentshare diff <from> <to>\` 展示新增、删除与修改的文件计数。

### Fixed

- \`install --force\` 在签名者变更时支持强制替换而非跳过。
\`\`\`

## 注意事项

- 切勿虚构日期、Issue 编号或贡献者信息。
- 切勿改写历史版本章节；变更日志仅做追加。`,
  ],
  [
    `---
name: pr-description
description: Write a pull request description from a diff or commit list. Use when opening or updating a PR, or when asked to summarize branch changes for review.
---

# PR Description

Write descriptions a reviewer can act on: problem first, then approach, then evidence.

## Workflow

1. Inspect the change (\`git diff <base>...HEAD --stat\`, plus the full diff for files whose intent is not obvious from names) or use the summary the user provides.
2. Lead with the problem and the approach. Do not narrate file by file.
3. Add a \`Verified\` section listing the exact commands run and their outcome (tests, typecheck, smoke). Never claim a check you did not run.
4. Call out breaking changes, migrations, and follow-ups first-class; silence is a claim.
5. Keep it under about 20 lines unless the change is genuinely large.

## Template

\`\`\`markdown
## What

One paragraph: the problem and the chosen approach.

## Verified

- \`pnpm test\`: 81 passed
- \`agentshare export ow/name --out /tmp/skills\`: two skill directories written

## Follow-ups

- Known limitation or next step.
\`\`\`

## What not to do

- Do not pad with a diff summary the reviewer can read.
- Do not claim verification that was not performed.`,
    `---
name: pr-description
description: 根据代码差异或提交列表编写合并请求（PR）描述。适用于创建或更新 PR，或为代码审查汇总分支变更。
---

# PR 描述生成 (PR Description)

编写便于审查者快速决策的 PR 描述：先阐明问题，再说明方案，最后列出验证证据。

## 工作流

1. 检查代码变更（\`git diff <base>...HEAD --stat\` 及关键文件完整差异）或使用用户提供的变更摘要。
2. 开篇点明背景问题与技术方案，避免逐个文件流水账式复述。
3. 添加 \`Verified\` 章节，列出实际执行的验证命令及其结果（单元测试、类型检查、冒烟测试），严禁虚构未执行的检查。
4. 明确标注破坏性变更、数据迁移步骤与后续待办事项。
5. 除大型变更外，正文保持在 20 行以内。

## 模板

\`\`\`markdown
## 变更内容 (What)

用一段话概述要解决的问题与所选方案。

## 验证结果 (Verified)

- \`pnpm test\`: 81 项测试全部通过
- \`agentshare export ow/name --out /tmp/skills\`: 成功导出两个技能目录

## 后续事项 (Follow-ups)

- 已知限制或下一步计划。
\`\`\`

## 注意事项

- 不要堆砌审查者可直接查看的 diff 统计。
- 严禁声称已通过未实际运行的验证。`,
  ],
  [
    `---
name: hello-handoff
description: Answer questions about a handed-off project using its bundled notes. Use when someone asks how the project works, what is in flight, where things live, or who to contact, after the original owner has left or gone on leave.
---

# Hello Handoff

You are the handoff agent for a project whose owner is unavailable. Answer from the bundled notes first; say "not in the notes" out loud when something is missing instead of guessing.

## Workflow

1. Read \`references/handoff.md\` before answering anything substantive.
2. Answer concretely: file paths, commands, owners, dates. Quote the note when precision matters.
3. If the answer is not in the notes, say so and suggest who or where to ask next.
4. Never invent repository URLs, credentials, or people. Secret names may be mentioned; values never exist in this pack.

## Good answers look like

- "Deploys run from \`scripts/release.sh\`, owned by @alice until 2026-10-01 (notes, 2026-09-02)."
- "That is not in the handoff notes. The closest context is the incident note from 2026-08-14; ask #platform-help for the rest."

## What not to do

- Do not claim knowledge you do not have from the notes.
- Do not perform irreversible actions (deploys, deletions) on the owner's behalf without explicit confirmation.`,
    `---
name: hello-handoff
description: 基于内置交接笔记回答交接项目的相关问题。适用于原负责人在休假或离岗后，团队成员询问项目架构、进行中任务、代码位置或对接人。
---

# 项目交接助手 (Hello Handoff)

您是该项目在原负责人暂不可用期间的交接智能体。请优先依据内置交接笔记作答；若笔记中未包含相关信息，请明确告知「交接笔记中未记录」，切勿凭空猜测。

## 工作流

1. 在回答任何实质性问题前，先读取 \`references/handoff.md\`。
2. 给出具体明确的答复：文件路径、命令、负责人、日期；在需要精确表述时直接引用笔记原文。
3. 若答案不在交接笔记中，请如实说明，并建议接下来可咨询的联系人或渠道。
4. 切勿虚构代码仓库地址、凭证或人员信息；仅可提及密钥名称，本技能包中绝不包含任何密钥明文。

## 回答示例

- 「部署脚本位于 \`scripts/release.sh\`，在 2026-10-01 前由 @alice 负责（源自 2026-09-02 交接笔记）。」
- 「交接笔记中未包含该内容。最接近的上下文是 2026-08-14 的故障复盘记录；其余细节请咨询 #platform-help 频道。」

## 注意事项

- 切勿声称掌握交接笔记以外的未证实信息。
- 未经明确授权确认，切勿代表原负责人执行不可逆操作（如生产部署、资源删除）。`,
  ],
  // Seeded Share / Handoff fields
  ["local docker expose", "本地 Docker 隧道共享"],
  ["Demo Handoff", "演示项目交接"],
  ["Ship the thing", "完成版本交付与上线"],
  ["tests pass", "全部测试通过"],
  ["no new deps", "不引入新依赖"],
  ["node 24", "Node 24 运行环境"],
  ["Design doc", "架构设计文档"],
  ["Use A2A", "采用 A2A 协议"],
  ["standard", "遵循标准跨智能体通信协议"],
  ["done thing", "已完成基础模块"],
  ["todo thing", "待完成集成测试"],
  ["Patch", "补丁文件"],
  ["which registry?", "发布到哪个注册中心？"],
  ["Changelog", "变更日志"],
  ["PR Description", "合并请求描述"],
  // Reactive error messages
  [
    "No executable entrypoint (index.js, main.js, run.sh) or SKILL.md found in pack.",
    "包内未找到可执行入口（index.js、main.js、run.sh）或 SKILL.md。",
  ],
  ["No executable entrypoint or SKILL.md found", "未找到可执行入口或 SKILL.md"],
  ["agent.json not found in the tarball", "归档包中未找到 agent.json"],
  ["agent.json is not valid JSON", "agent.json 不是有效的 JSON"],
  ["agent.json must be an object", "agent.json 必须是 JSON 对象"],
  [
    "choose a tarball created by `agentshare pack` first",
    "请先选择由 `agentshare pack` 生成的 .tgz 归档包",
  ],
  [
    "API token is required (or sign in via this registry's OIDC login)",
    "需要填写 API 访问令牌（或先登录账户）",
  ],
  ["Username and password are required.", "请输入用户名和密码。"],
  ["username and password are required", "请输入用户名和密码。"],
  ["Please paste a valid Bearer token.", "请粘贴有效的访问令牌。"],
  ["Invalid access token.", "无效的访问令牌。"],
  ["Please sign in to run packs in the sandbox.", "请先登录以在沙箱中运行技能包。"],
  ["unauthorized", "未授权访问，请先登录"],
  ["invalid username or password", "用户名或密码错误"],
  ["Invalid username or password", "用户名或密码错误"],
  ["invalid credentials", "用户名或密码错误"],
  ["username already exists", "用户名已存在"],
  ["User already exists", "用户名已存在"],
  ["password must be at least 4 characters", "密码长度至少为 4 位字符"],
  [
    "invalid username: must be lowercase alphanumeric or hyphens (1-39 chars, no leading/trailing hyphen)",
    "无效的用户名：必须为 1-39 位小写字母、数字或连字符（不能以连字符开头或结尾）",
  ],
  ["not found", "未找到请求的资源"],
  ["rate limit exceeded", "请求过于频繁，请稍后再试"],
  ["share is offline", "共享会话当前离线"],
  ["share is revoked", "此共享会话已被撤销"],
];

const EN_TO_ZH_MAP = new Map<string, string>();
const EN_LOWER_TO_ZH_MAP = new Map<string, string>();
const ZH_TO_EN_MAP = new Map<string, string>();
for (const [enText, zhText] of DYNAMIC_PAIRS) {
  const normEn = enText.replace(/\r\n/g, "\n").trim();
  const normZh = zhText.replace(/\r\n/g, "\n").trim();
  EN_TO_ZH_MAP.set(normEn, zhText);
  if (!EN_LOWER_TO_ZH_MAP.has(normEn.toLowerCase())) {
    EN_LOWER_TO_ZH_MAP.set(normEn.toLowerCase(), zhText);
  }
  if (!ZH_TO_EN_MAP.has(normZh)) {
    ZH_TO_EN_MAP.set(normZh, enText);
  }
}

export function translatePackText(text: string, locale: Locale): string {
  if (!text) return text;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (locale === "zh") {
    const direct = EN_TO_ZH_MAP.get(normalized) ?? EN_LOWER_TO_ZH_MAP.get(normalized.toLowerCase());
    if (direct !== undefined) return direct;
    const missingMatch = /^agent\.json is missing "(.+)"$/i.exec(normalized);
    if (missingMatch) {
      return `agent.json 缺少必填字段 "${missingMatch[1]}"`;
    }
    const immutableMatch = /^(.+@.+) already exists, releases are immutable$/i.exec(normalized);
    if (immutableMatch) {
      return `${immutableMatch[1]} 已存在，发布版本不可篡改`;
    }
    const registeredMatch = /^user "(.+)" is already registered$/i.exec(normalized);
    if (registeredMatch) {
      return `用户 "${registeredMatch[1]}" 已注册`;
    }
    const forbiddenPublishMatch =
      /^forbidden: you do not have permission to publish to (.+)$/i.exec(normalized);
    if (forbiddenPublishMatch) {
      return `禁止访问：您没有权限发布到 ${forbiddenPublishMatch[1]}`;
    }
    return text;
  }
  const reverse = ZH_TO_EN_MAP.get(normalized);
  if (reverse !== undefined) return reverse;
  const missingZhMatch = /^agent\.json 缺少必填字段 "(.+)"$/.exec(normalized);
  if (missingZhMatch) {
    return `agent.json is missing "${missingZhMatch[1]}"`;
  }
  const immutableZhMatch = /^(.+@.+) 已存在，发布版本不可篡改$/.exec(normalized);
  if (immutableZhMatch) {
    return `${immutableZhMatch[1]} already exists, releases are immutable`;
  }
  const registeredZhMatch = /^用户 "(.+)" 已注册$/.exec(normalized);
  if (registeredZhMatch) {
    return `user "${registeredZhMatch[1]}" is already registered`;
  }
  const forbiddenPublishZhMatch = /^禁止访问：您没有权限发布到 (.+)$/.exec(normalized);
  if (forbiddenPublishZhMatch) {
    return `forbidden: you do not have permission to publish to ${forbiddenPublishZhMatch[1]}`;
  }
  return text;
}

const EVIDENCE_KIND_ZH: Record<string, string> = {
  file: "文件",
  path: "文件",
  command: "命令",
  url: "链接",
  commit: "提交",
  note: "笔记",
  transcript: "记录",
};

export function translateEvidenceKind(kind: string, locale: Locale): string {
  if (locale === "zh") {
    return EVIDENCE_KIND_ZH[kind] ?? kind;
  }
  return kind;
}

export interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey) => string;
  td: (text: string) => string;
}

const defaultLocale: Locale = "en";

const LanguageContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key: TranslationKey) => translations.en[key],
  td: (text: string) => translatePackText(text, defaultLocale),
});

function syncHtmlLang(locale: Locale): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = getInitialLocale();
    syncHtmlLang(initial);
    return initial;
  });

  useEffect(() => {
    syncHtmlLang(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    syncHtmlLang(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next: Locale = prev === "en" ? "zh" : "en";
      syncHtmlLang(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[locale][key] ?? translations.en[key];
    },
    [locale],
  );

  const td = useCallback(
    (text: string): string => {
      return translatePackText(text, locale);
    },
    [locale],
  );

  return (
    <LanguageContext.Provider value={{ locale, setLocale, toggleLocale, t, td }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(LanguageContext);
}
