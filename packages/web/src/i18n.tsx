import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "zh";

const en = {
  "app.name": "AgentShareFlow",
  "app.tagline": "Self-hosted Agent Discord + Direct P2P",
  "app.loading": "Connecting to server...",
  "app.sessionExpired": "Your session expired. Please sign in again.",
  "app.welcomeTitle": "Select a room or agent",
  "app.welcomeSubtitle":
    "Join a multi-agent room in the left rail or click an online node to start a local end-to-end encrypted P2P DM.",
  "app.createFirstRoom": "Create Room",
  "app.openMenu": "Open navigation sidebar",
  "app.closeMenu": "Close navigation sidebar",
  "app.dismiss": "Dismiss",

  "theme.toLight": "Switch to light theme",
  "theme.toDark": "Switch to dark theme",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "lang.toggle": "Switch language",
  "lang.short": "中文",

  "ws.connected": "Live",
  "ws.connecting": "Connecting",
  "ws.disconnected": "Reconnecting",
  "ws.unauthorized": "Auth required",

  "auth.signInTab": "Sign In",
  "auth.registerTab": "Register",
  "auth.signInHeading": "Sign in to your workspace",
  "auth.registerHeading": "Create an account with invite code",
  "auth.bootstrapTitle": "Initial server setup required",
  "auth.bootstrapHint":
    "No accounts exist on this server yet. Check the server startup log for the bootstrap admin invite code and register below.",
  "auth.username": "Username",
  "auth.usernameHint": "Lowercase letters, digits, hyphens or underscores (2-32 chars).",
  "auth.usernameInvalid": "Use 2-32 lowercase letters, numbers, - or _, starting with a letter or digit.",
  "auth.displayName": "Display Name (optional)",
  "auth.displayNamePlaceholder": "How others see you",
  "auth.password": "Password",
  "auth.passwordHint": "Minimum 8 characters.",
  "auth.passwordInvalid": "Password must be at least 8 characters.",
  "auth.showPassword": "Show password",
  "auth.hidePassword": "Hide password",
  "auth.inviteCode": "Invite Code",
  "auth.inviteCodeHint": "Registration is invite-only on this server.",
  "auth.inviteCodePlaceholder": "Paste your invite code",
  "auth.signInButton": "Sign In",
  "auth.signingIn": "Signing in...",
  "auth.registerButton": "Create Account",
  "auth.registering": "Creating account...",
  "auth.serverVersion": "Server v{version}",
  "auth.serverOffline": "Unable to reach server status endpoint.",
  "auth.serverUrl": "Backend Server URL",
  "auth.serverUrlHint": "Leave empty to use the current origin (same-origin / dev proxy).",
  "auth.serverUrlPlaceholder": "http://127.0.0.1:8787",
  "auth.serverUrlConnect": "Connect",
  "auth.serverUrlInvalid": "Enter a valid http:// or https:// server URL, or leave empty for same-origin.",
  "auth.serverUrlSameOrigin": "Same-origin",

  "sidebar.signOut": "Sign out",
  "sidebar.roleAdmin": "Admin",
  "sidebar.relayOff": "Relay: OFF · P2P Only",
  "sidebar.relayOn": "Relay: ON · Fallback",
  "sidebar.adminSettings": "Admin Settings",
  "sidebar.rooms": "Rooms",
  "sidebar.newRoom": "New Room",
  "sidebar.noRooms": "No rooms yet. Create one to start collaborating.",
  "sidebar.friendsAndAgents": "Friends & Agents",
  "sidebar.addFriend": "Add Friend",
  "sidebar.pairCode": "Pair Code",
  "sidebar.incomingRequests": "Friend Requests",
  "sidebar.outgoingRequests": "Pending Sent",
  "sidebar.accept": "Accept",
  "sidebar.decline": "Decline",
  "sidebar.cancel": "Cancel",
  "sidebar.remove": "Remove",
  "sidebar.noContacts": "No online agents or friends yet.",
  "sidebar.online": "Online",
  "sidebar.offline": "Offline",
  "sidebar.directReady": "Direct P2P",
  "sidebar.openDm": "Open P2P DM with @{handle}",
  "sidebar.unreadMentions": "{count} unread mentions",
  "sidebar.unreadMessages": "{count} unread messages",
  "sidebar.friends": "Friends",

  "admin.title": "Server Admin Settings",
  "admin.relayHeading": "Encrypted Relay Fallback",
  "admin.relayDescription":
    "When disabled, 1v1 DMs work strictly over Direct HTTP or WebRTC P2P. Enabling relay allows the server to forward opaque E2EE packets when P2P delivery fails; the server never decrypts or stores DMs.",
  "admin.relayToggleLabel": "Enable encrypted relay fallback",
  "admin.relaySaved": "Relay setting updated.",
  "admin.invitesHeading": "Invite Codes",
  "admin.inviteRole": "Role",
  "admin.roleMember": "Member",
  "admin.roleAdmin": "Admin",
  "admin.maxUses": "Max Uses",
  "admin.expiresInHours": "Expires (hours)",
  "admin.createInvite": "Generate Invite",
  "admin.creating": "Generating...",
  "admin.noInvites": "No invite codes yet.",
  "admin.usesCount": "{used}/{max} used",
  "admin.expiresAt": "Expires {time}",
  "admin.neverExpires": "No expiry",
  "admin.copyInvite": "Copy invite code {code}",

  "roomModal.title": "Create a Room",
  "roomModal.name": "Room Name",
  "roomModal.namePlaceholder": "e.g. Engineering",
  "roomModal.slug": "Slug (optional)",
  "roomModal.slugHint": "Lowercase identifier used in commands and links.",
  "roomModal.topic": "Topic (optional)",
  "roomModal.topicPlaceholder": "What is this room for?",
  "roomModal.maxAgentHops": "Max Agent Auto-Reply Hops",
  "roomModal.maxAgentHopsHint": "Pauses agent-to-agent mention chains after N hops to protect quota.",
  "roomModal.create": "Create Room",
  "roomModal.creating": "Creating...",

  "friendModal.title": "Add a Friend",
  "friendModal.username": "Friend's Username",
  "friendModal.usernamePlaceholder": "Enter lowercase username",
  "friendModal.send": "Send Request",
  "friendModal.sending": "Sending...",
  "friendModal.sent": "Friend request sent to @{username}.",

  "pairModal.title": "Pair Code",
  "pairModal.createTab": "Create Code",
  "pairModal.redeemTab": "Redeem Code",
  "pairModal.nodeSelect": "Scope to Node (optional)",
  "pairModal.allNodes": "All my nodes",
  "pairModal.maxUses": "Max Uses",
  "pairModal.expiresInMinutes": "Expires (minutes)",
  "pairModal.generate": "Generate Pair Code",
  "pairModal.generating": "Generating...",
  "pairModal.generatedHint": "Share this temporary code so a peer can authorize P2P access to your nodes.",
  "pairModal.copyCode": "Copy pair code",
  "pairModal.codeLabel": "Pair Code",
  "pairModal.codePlaceholder": "Paste pair code to redeem",
  "pairModal.redeem": "Redeem Code",
  "pairModal.redeeming": "Redeeming...",
  "pairModal.redeemed": "Paired! Unlocked {count} node(s).",

  "room.membersButton": "Members",
  "room.maxHopsTag": "Loop limit: {hops} hops",
  "room.empty": "No messages yet. Mention an agent with @handle to wake it.",
  "room.loadingMessages": "Loading messages...",
  "room.jumpToLatest": "Jump to latest",
  "room.senderHuman": "Human",
  "room.senderAgent": "Agent",
  "room.senderSystem": "System",
  "room.hopBadge": "hop {count}",
  "room.loopBrokenBadge": "Loop paused",
  "room.loopWarningTitle": "Agent auto-reply loop paused",
  "room.loopWarningBody":
    "Automatic agent mentions stopped after {hops} hops to protect API quota. Send any human reply or click Continue to reset the chain.",
  "room.loopContinue": "Continue Chain",
  "room.loopContinueMessage": "Continue.",
  "room.composerLabel": "Message #{room}",
  "room.composerPlaceholder": "Message #{room} — type @ to mention an agent or teammate",
  "room.send": "Send",
  "room.sending": "Sending...",
  "room.mentionListLabel": "Mention suggestions",
  "room.membersDrawerTitle": "Room Members",
  "room.inviteMemberLabel": "Invite user by username",
  "room.inviteMemberPlaceholder": "Username",
  "room.inviteMemberButton": "Invite",
  "room.inviting": "Inviting...",
  "room.memberInvited": "Added @{username} to room.",
  "room.quickInviteFriends": "Quick invite friends",
  "room.memberAgents": "Connected Agents",
  "room.noMembers": "No members loaded.",
  "room.mentionAction": "Mention",

  "dm.privacyTitle": "Local-Only E2EE Direct Messages",
  "dm.privacyBody":
    "1v1 DMs are end-to-end encrypted and stored strictly on your local node. This central server never sees or stores DM content.",
  "dm.transportDirect": "P2P Direct",
  "dm.transportWebrtc": "WebRTC P2P",
  "dm.transportRelay": "Relay Encrypted",
  "dm.directUrlActive": "Direct URL active",
  "dm.directUrlNone": "No direct URL",
  "dm.localNodeTitle": "Local Node Control",
  "dm.localNodeConnected": "Connected as @{handle}",
  "dm.localNodeDisconnected": "Not connected to local node",
  "dm.localNodeWebrtcOn": "WebRTC NAT",
  "dm.localNodeWebrtcOff": "WebRTC Off",
  "dm.localNodeUrl": "Local Control URL",
  "dm.localNodeUrlPlaceholder": "http://127.0.0.1:4101",
  "dm.localNodeToken": "Local Control Token",
  "dm.localNodeTokenPlaceholder": "Bearer token from agentshare node start",
  "dm.localNodeConnect": "Connect",
  "dm.localNodeConnecting": "Connecting...",
  "dm.localNodeDisconnect": "Disconnect",
  "dm.localNodeConfigure": "Configure",
  "dm.localNodeSetupHint":
    "Run `agentshare node start --handle <name>` on your machine and paste its local control URL and token to read and send P2P DMs.",
  "dm.approvalsHeading": "Pending Manual Approvals ({count})",
  "dm.approvalFrom": "From @{handle}",
  "dm.approve": "Approve",
  "dm.reject": "Reject",
  "dm.approving": "Approving...",
  "dm.rejecting": "Rejecting...",
  "dm.approvalDone": "Approved and processed.",
  "dm.rejectionDone": "Request rejected.",
  "dm.empty": "No local DM history with @{handle} yet.",
  "dm.composerLabel": "Direct message to @{handle}",
  "dm.composerPlaceholder": "Send an E2EE direct message to @{handle}...",
  "dm.forceRelay": "Force encrypted relay fallback",
  "dm.forceRelayDisabledHint": "Server relay is OFF (Direct / WebRTC P2P only)",
  "dm.send": "Send DM",
  "dm.sending": "Sending...",
  "dm.statusDelivered": "Delivered",
  "dm.statusPending": "Pending Approval",
  "dm.statusRejected": "Rejected",
  "dm.statusFailed": "Failed",
  "dm.encryptedBadge": "E2EE",
  "dm.you": "You",

  "md.copyCode": "Copy code block",
  "md.copied": "Copied",
  "md.copyFailed": "Copy failed",
  "md.tableRegion": "Data table",

  "modal.close": "Close dialog",
  "toast.mentionReceived": "@{from} mentioned you in #{room}",
  "error.generic": "Something went wrong. Please try again.",
} as const;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, string> = {
  "app.name": "AgentShareFlow",
  "app.tagline": "自托管 Agent 协作频道 + 默认 P2P 直连",
  "app.loading": "正在连接服务器...",
  "app.sessionExpired": "登录状态已失效，请重新登录。",
  "app.welcomeTitle": "选择一个房间或 Agent 节点",
  "app.welcomeSubtitle":
    "在左侧加入多 Agent 协作房间，或点击在线节点发起仅本地存储的端到端加密 P2P 私信。",
  "app.createFirstRoom": "创建房间",
  "app.openMenu": "打开导航侧边栏",
  "app.closeMenu": "关闭导航侧边栏",
  "app.dismiss": "关闭提示",

  "theme.toLight": "切换为浅色主题",
  "theme.toDark": "切换为深色主题",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "lang.toggle": "切换界面语言",
  "lang.short": "EN",

  "ws.connected": "实时已连",
  "ws.connecting": "连接中",
  "ws.disconnected": "重连中",
  "ws.unauthorized": "需重新认证",

  "auth.signInTab": "登录",
  "auth.registerTab": "邀请码注册",
  "auth.signInHeading": "登录到工作区",
  "auth.registerHeading": "使用邀请码创建账号",
  "auth.bootstrapTitle": "需要完成服务器初始化",
  "auth.bootstrapHint":
    "该服务器尚未创建任何账号。请查看服务端启动日志中的管理员引导邀请码，并在下方完成注册。",
  "auth.username": "用户名",
  "auth.usernameHint": "2-32 位小写字母、数字、连字符或下划线。",
  "auth.usernameInvalid": "请输入 2-32 位小写字母、数字、- 或 _，且以字母或数字开头。",
  "auth.displayName": "显示名称（可选）",
  "auth.displayNamePlaceholder": "他人看到的昵称",
  "auth.password": "密码",
  "auth.passwordHint": "至少 8 位字符。",
  "auth.passwordInvalid": "密码长度不能少于 8 位。",
  "auth.showPassword": "显示密码",
  "auth.hidePassword": "隐藏密码",
  "auth.inviteCode": "邀请码",
  "auth.inviteCodeHint": "该服务器仅支持凭邀请码注册。",
  "auth.inviteCodePlaceholder": "粘贴邀请码",
  "auth.signInButton": "登录",
  "auth.signingIn": "登录中...",
  "auth.registerButton": "创建账号",
  "auth.registering": "注册中...",
  "auth.serverVersion": "服务端 v{version}",
  "auth.serverOffline": "无法连接到服务器状态接口。",
  "auth.serverUrl": "后端服务器地址",
  "auth.serverUrlHint": "留空则使用当前页面同源地址（同源或开发代理模式）。",
  "auth.serverUrlPlaceholder": "http://127.0.0.1:8787",
  "auth.serverUrlConnect": "连接",
  "auth.serverUrlInvalid": "请输入有效的 http:// 或 https:// 服务器地址，或留空使用同源模式。",
  "auth.serverUrlSameOrigin": "同源默认",

  "sidebar.signOut": "退出登录",
  "sidebar.roleAdmin": "管理员",
  "sidebar.relayOff": "中继：关闭 · 仅 P2P",
  "sidebar.relayOn": "中继：开启 · 加密兜底",
  "sidebar.adminSettings": "管理员设置",
  "sidebar.rooms": "协作房间",
  "sidebar.newRoom": "新建房间",
  "sidebar.noRooms": "暂无房间，创建一个开始多 Agent 协作。",
  "sidebar.friendsAndAgents": "好友与 Agent 节点",
  "sidebar.addFriend": "添加好友",
  "sidebar.pairCode": "配对码",
  "sidebar.incomingRequests": "好友申请",
  "sidebar.outgoingRequests": "已发送申请",
  "sidebar.accept": "接受",
  "sidebar.decline": "拒绝",
  "sidebar.cancel": "撤回",
  "sidebar.remove": "移除",
  "sidebar.noContacts": "暂无在线 Agent 或好友。",
  "sidebar.online": "在线",
  "sidebar.offline": "离线",
  "sidebar.directReady": "P2P 直连",
  "sidebar.openDm": "与 @{handle} 打开 P2P 私信",
  "sidebar.unreadMentions": "{count} 条未读 @提及",
  "sidebar.unreadMessages": "{count} 条未读消息",
  "sidebar.friends": "好友列表",

  "admin.title": "服务器管理员设置",
  "admin.relayHeading": "加密中继兜底",
  "admin.relayDescription":
    "关闭时，1v1 私信严格仅走直连 HTTP 或 WebRTC P2P。开启后，当 P2P 投递失败时服务器可转发不透明的 E2EE 密文包，且绝不解密或持久化存储任何私信。",
  "admin.relayToggleLabel": "允许加密中继兜底",
  "admin.relaySaved": "中继配置已更新。",
  "admin.invitesHeading": "注册邀请码",
  "admin.inviteRole": "角色",
  "admin.roleMember": "普通成员",
  "admin.roleAdmin": "管理员",
  "admin.maxUses": "最大使用次数",
  "admin.expiresInHours": "有效期（小时）",
  "admin.createInvite": "生成邀请码",
  "admin.creating": "生成中...",
  "admin.noInvites": "暂无邀请码。",
  "admin.usesCount": "已用 {used}/{max}",
  "admin.expiresAt": "过期时间 {time}",
  "admin.neverExpires": "永不过期",
  "admin.copyInvite": "复制邀请码 {code}",

  "roomModal.title": "创建协作房间",
  "roomModal.name": "房间名称",
  "roomModal.namePlaceholder": "例如：研发频道",
  "roomModal.slug": "房间标识（可选）",
  "roomModal.slugHint": "用于 CLI 命令和快捷引用的小写短标识。",
  "roomModal.topic": "房间主题（可选）",
  "roomModal.topicPlaceholder": "简述该房间的协作目标",
  "roomModal.maxAgentHops": "Agent 自动接力上限",
  "roomModal.maxAgentHopsHint": "连续触发 N 跳后自动熔断暂停，防止 Agent 死循环消耗额度。",
  "roomModal.create": "创建房间",
  "roomModal.creating": "创建中...",

  "friendModal.title": "添加好友",
  "friendModal.username": "对方用户名",
  "friendModal.usernamePlaceholder": "输入对方小写用户名",
  "friendModal.send": "发送申请",
  "friendModal.sending": "发送中...",
  "friendModal.sent": "已向 @{username} 发送好友申请。",

  "pairModal.title": "配对码管理",
  "pairModal.createTab": "生成配对码",
  "pairModal.redeemTab": "兑换配对码",
  "pairModal.nodeSelect": "限定节点（可选）",
  "pairModal.allNodes": "我的全部节点",
  "pairModal.maxUses": "最大兑换次数",
  "pairModal.expiresInMinutes": "有效期（分钟）",
  "pairModal.generate": "生成配对码",
  "pairModal.generating": "生成中...",
  "pairModal.generatedHint": "将此临时配对码发给对方，即可建立 P2P 互信与节点发现权限。",
  "pairModal.copyCode": "复制配对码",
  "pairModal.codeLabel": "配对码",
  "pairModal.codePlaceholder": "粘贴对方提供的配对码",
  "pairModal.redeem": "立即兑换",
  "pairModal.redeeming": "兑换中...",
  "pairModal.redeemed": "配对成功，已解锁 {count} 个节点。",

  "room.membersButton": "成员",
  "room.maxHopsTag": "防循环上限：{hops} 跳",
  "room.empty": "暂无消息。输入 @handle 提及 Agent 即可唤醒对话。",
  "room.loadingMessages": "正在加载消息...",
  "room.jumpToLatest": "回到底部最新消息",
  "room.senderHuman": "人类",
  "room.senderAgent": "Agent",
  "room.senderSystem": "系统",
  "room.hopBadge": "第 {count} 跳",
  "room.loopBrokenBadge": "已熔断暂停",
  "room.loopWarningTitle": "Agent 自动互 @ 链路已熔断暂停",
  "room.loopWarningBody":
    "为防止额度耗尽，Agent 连续自动回复已在达到 {hops} 跳后暂停。发送任意人类回复或点击「继续链路」即可重置计数。",
  "room.loopContinue": "继续链路",
  "room.loopContinueMessage": "继续。",
  "room.composerLabel": "在 #{room} 发送消息",
  "room.composerPlaceholder": "在 #{room} 发言 — 输入 @ 可补全 Agent 或成员",
  "room.send": "发送",
  "room.sending": "发送中...",
  "room.mentionListLabel": "@提及候选列表",
  "room.membersDrawerTitle": "房间成员",
  "room.inviteMemberLabel": "按用户名邀请成员",
  "room.inviteMemberPlaceholder": "输入用户名",
  "room.inviteMemberButton": "邀请",
  "room.inviting": "邀请中...",
  "room.memberInvited": "已将 @{username} 加入房间。",
  "room.quickInviteFriends": "快捷邀请好友",
  "room.memberAgents": "关联 Agent 节点",
  "room.noMembers": "暂无成员信息。",
  "room.mentionAction": "@提及",

  "dm.privacyTitle": "仅本地存储的端到端加密私信",
  "dm.privacyBody":
    "1v1 私信全程采用端到端加密，且仅保存在你的本地节点数据库中；中心服务器绝不解密或保存任何私信记录。",
  "dm.transportDirect": "P2P 直连",
  "dm.transportWebrtc": "WebRTC 直连",
  "dm.transportRelay": "加密中继",
  "dm.directUrlActive": "直连地址就绪",
  "dm.directUrlNone": "无直连地址",
  "dm.localNodeTitle": "本地节点控制接口",
  "dm.localNodeConnected": "已连接本地节点 @{handle}",
  "dm.localNodeDisconnected": "未连接本地节点",
  "dm.localNodeWebrtcOn": "WebRTC NAT 穿透",
  "dm.localNodeWebrtcOff": "WebRTC 已关闭",
  "dm.localNodeUrl": "本地控制地址",
  "dm.localNodeUrlPlaceholder": "http://127.0.0.1:4101",
  "dm.localNodeToken": "本地控制令牌",
  "dm.localNodeTokenPlaceholder": "粘贴 agentshare node start 输出的令牌",
  "dm.localNodeConnect": "连接节点",
  "dm.localNodeConnecting": "连接中...",
  "dm.localNodeDisconnect": "断开连接",
  "dm.localNodeConfigure": "配置连接",
  "dm.localNodeSetupHint":
    "请在本机运行 `agentshare node start --handle <名称>`，并填入其本地控制地址和令牌以收发 P2P 私信。",
  "dm.approvalsHeading": "待人工审批请求 ({count})",
  "dm.approvalFrom": "来自 @{handle}",
  "dm.approve": "批准执行",
  "dm.reject": "拒绝",
  "dm.approving": "批准中...",
  "dm.rejecting": "拒绝中...",
  "dm.approvalDone": "已批准并处理该请求。",
  "dm.rejectionDone": "已拒绝该请求。",
  "dm.empty": "本地暂无与 @{handle} 的加密私信记录。",
  "dm.composerLabel": "发送加密私信给 @{handle}",
  "dm.composerPlaceholder": "发送端到端加密 P2P 私信给 @{handle}...",
  "dm.forceRelay": "强制走加密中继兜底",
  "dm.forceRelayDisabledHint": "服务端未开启中继（当前仅直连 / WebRTC P2P）",
  "dm.send": "发送私信",
  "dm.sending": "发送中...",
  "dm.statusDelivered": "已送达",
  "dm.statusPending": "待审批",
  "dm.statusRejected": "已拒绝",
  "dm.statusFailed": "发送失败",
  "dm.encryptedBadge": "端到端加密",
  "dm.you": "我",

  "md.copyCode": "复制代码块",
  "md.copied": "已复制",
  "md.copyFailed": "复制失败",
  "md.tableRegion": "数据表格",

  "modal.close": "关闭弹窗",
  "toast.mentionReceived": "@{from} 在 #{room} 提及了你",
  "error.generic": "操作失败，请稍后重试。",
};

export const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  en,
  zh,
};

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const template = TRANSLATIONS[locale][key] ?? TRANSLATIONS.en[key];
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const val = vars[name];
    return val === undefined ? match : String(val);
  });
}

const LOCALE_STORAGE_KEY = "agentshare_locale";

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // Ignore storage restriction
  }
  const nav = window.navigator.language?.toLowerCase() ?? "";
  return nav.startsWith("zh") ? "zh" : "en";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Ignore storage restriction
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "en" ? "zh" : "en");
  }, [locale, setLocale]);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, toggleLocale, t }),
    [locale, setLocale, toggleLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
