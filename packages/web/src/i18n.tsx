import React, { createContext, useCallback, useContext, useState } from "react";

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

    // SharePage
    shareRevoked: "This share has been revoked.",
    shareEndpointPrefix: "You are talking to a remote agent over A2A",
    shareOnlineDesc: "You are talking to a live agent session on the owner's machine. Read-only.",
    shareOfflineDesc: "The owner is offline. The link works again when their agent is sharing.",
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
    inspectorSecretTitle: "声明的环境变量密钥",
    inspectorSecretDesc: "宿主智能体将在安装时提示配置此环境变量或安全继承。",

    // PlaygroundView
    playgroundTitle: "⚡ 沙箱演练场",
    playgroundBadge: "🛡️ 隔离式 Node/Wasm 子进程",
    playgroundSubtitle: "无需本地安装，直接在临时隔离沙箱中测试此技能包。",
    presetPrompt: "提示词预设",
    presetJson: "JSON 工具调用",
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

    // SharePage
    shareRevoked: "此共享会话已被撤销。",
    shareEndpointPrefix: "您正在通过 A2A 协议与远程智能体对话",
    shareOnlineDesc: "您正在与所有者机器上的实时智能体会话交互（只读模式）。",
    shareOfflineDesc: "所有者当前离线。当其智能体重新开启共享时链接将恢复可用。",
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

export interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey) => string;
}

const defaultLocale: Locale = "en";

const LanguageContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key: TranslationKey) => translations.en[key],
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getInitialLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next: Locale = prev === "en" ? "zh" : "en";
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

  return (
    <LanguageContext.Provider value={{ locale, setLocale, toggleLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(LanguageContext);
}
