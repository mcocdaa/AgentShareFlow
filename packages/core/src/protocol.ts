import { z } from "zod";

export const PROTOCOL_VERSION = 2 as const;
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const DEFAULT_MAX_AGENT_HOPS = 5;

export const UserRoleSchema = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: UserRoleSchema,
  createdAt: z.number(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const NodeKindSchema = z.enum(["mcp", "http", "a2a", "cli", "human-web"]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const NodePresenceSchema = z.object({
  nodeId: z.string(),
  ownerUserId: z.string(),
  ownerUsername: z.string(),
  handle: z.string(),
  displayName: z.string(),
  kind: NodeKindSchema,
  description: z.string(),
  capabilities: z.array(z.string()),
  signPublicKey: z.string(),
  kxPublicKey: z.string(),
  directUrl: z.string().nullable(),
  online: z.boolean(),
  lastSeenAt: z.number(),
});
export type NodePresence = z.infer<typeof NodePresenceSchema>;

export const FriendRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  friendUserId: z.string(),
  friendUsername: z.string(),
  friendDisplayName: z.string(),
  status: z.enum(["pending", "accepted"]),
  direction: z.enum(["incoming", "outgoing"]),
  createdAt: z.number(),
});
export type FriendRecord = z.infer<typeof FriendRecordSchema>;

export const PairCodeRecordSchema = z.object({
  code: z.string(),
  creatorUserId: z.string(),
  creatorNodeId: z.string().nullable(),
  expiresAt: z.number(),
  maxUses: z.number(),
  usedCount: z.number(),
});
export type PairCodeRecord = z.infer<typeof PairCodeRecordSchema>;

export const RoomSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  topic: z.string(),
  createdBy: z.string(),
  maxAgentHops: z.number(),
  createdAt: z.number(),
  unreadCount: z.number().optional(),
  mentionCount: z.number().optional(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const RoomMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number(),
  senderType: z.enum(["human", "agent", "system"]),
  senderUserId: z.string(),
  senderNodeId: z.string().nullable(),
  senderHandle: z.string(),
  content: z.string(),
  mentions: z.array(z.string()),
  hopCount: z.number(),
  hopChainId: z.string().nullable(),
  loopBroken: z.boolean(),
  createdAt: z.number(),
});
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const TransportModeSchema = z.enum(["direct", "webrtc", "relay"]);
export type TransportMode = z.infer<typeof TransportModeSchema>;

export const InboxItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["room_mention", "dm", "approval_request"]),
  fromHandle: z.string(),
  fromNodeId: z.string().nullable(),
  roomId: z.string().nullable(),
  roomName: z.string().nullable(),
  messageId: z.string(),
  preview: z.string(),
  transport: TransportModeSchema.optional(),
  createdAt: z.number(),
  read: z.boolean(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const EncryptedEnvelopeSchema = z.object({
  alg: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

export const P2pPacketSchema = z.object({
  version: z.literal(2),
  id: z.string(),
  fromNodeId: z.string(),
  fromHandle: z.string(),
  toNodeId: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
  envelope: EncryptedEnvelopeSchema,
  signature: z.string(),
});
export type P2pPacket = z.infer<typeof P2pPacketSchema>;

export const DmPayloadSchema = z.object({
  kind: z.enum(["text", "task_request", "task_result"]),
  text: z.string(),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DmPayload = z.infer<typeof DmPayloadSchema>;

export const DmMessageSchema = z.object({
  id: z.string(),
  peerNodeId: z.string(),
  peerHandle: z.string(),
  direction: z.enum(["in", "out"]),
  content: z.string(),
  transport: TransportModeSchema,
  encrypted: z.boolean(),
  status: z.enum(["delivered", "pending_approval", "rejected", "failed"]),
  createdAt: z.number(),
});
export type DmMessage = z.infer<typeof DmMessageSchema>;

export const ApprovalPolicyModeSchema = z.enum([
  "auto",
  "read_only_scoped",
  "manual_approval",
]);
export type ApprovalPolicyMode = z.infer<typeof ApprovalPolicyModeSchema>;

export const PeerPolicyRuleSchema = z.object({
  subject: z.string(),
  allow: z.boolean(),
  mode: ApprovalPolicyModeSchema,
  maxRequestsPerHour: z.number(),
  allowedDir: z.string().optional(),
});
export type PeerPolicyRule = z.infer<typeof PeerPolicyRuleSchema>;

export const NodePolicyConfigSchema = z.object({
  defaultAllow: z.boolean(),
  defaultMode: ApprovalPolicyModeSchema,
  defaultMaxRequestsPerHour: z.number(),
  allowedDir: z.string().optional(),
  rules: z.array(PeerPolicyRuleSchema),
});
export type NodePolicyConfig = z.infer<typeof NodePolicyConfigSchema>;

export const SignalTypeSchema = z.enum([
  "direct_probe",
  "webrtc_sdp",
  "webrtc_ice",
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

export const IceServerConfigSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerConfigSchema>;

export const ClientToServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("node.register"),
    nodeId: z.string(),
    handle: z.string(),
    displayName: z.string(),
    kind: NodeKindSchema,
    description: z.string(),
    capabilities: z.array(z.string()),
    signPublicKey: z.string(),
    kxPublicKey: z.string(),
    directUrl: z.string().nullable(),
  }),
  z.object({
    type: z.literal("room.subscribe"),
    roomId: z.string(),
  }),
  z.object({
    type: z.literal("room.send"),
    roomId: z.string(),
    content: z.string(),
    senderNodeId: z.string().optional(),
    hopChainId: z.string().optional(),
    resetLoop: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("signal.offer"),
    toNodeId: z.string(),
    signalType: SignalTypeSchema,
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("signal.answer"),
    toNodeId: z.string(),
    signalType: SignalTypeSchema,
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("relay.forward"),
    toNodeId: z.string(),
    packet: P2pPacketSchema,
  }),
]);
export type ClientToServerFrame = z.infer<typeof ClientToServerFrameSchema>;

export const ServerToClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pong"),
  }),
  z.object({
    type: z.literal("node.registered"),
    node: NodePresenceSchema,
    relayEnabled: z.boolean(),
    iceServers: z.array(IceServerConfigSchema).optional(),
  }),
  z.object({
    type: z.literal("presence.update"),
    node: NodePresenceSchema,
  }),
  z.object({
    type: z.literal("room.message"),
    message: RoomMessageSchema,
  }),
  z.object({
    type: z.literal("inbox.mention"),
    item: InboxItemSchema,
    message: RoomMessageSchema,
  }),
  z.object({
    type: z.literal("room.loop_broken"),
    roomId: z.string(),
    hopChainId: z.string(),
    hopCount: z.number(),
    maxAgentHops: z.number(),
    message: RoomMessageSchema,
  }),
  z.object({
    type: z.literal("signal.deliver"),
    fromNodeId: z.string(),
    fromHandle: z.string(),
    signalType: SignalTypeSchema,
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("relay.deliver"),
    fromNodeId: z.string(),
    fromHandle: z.string(),
    packet: P2pPacketSchema,
  }),
  z.object({
    type: z.literal("settings.update"),
    relayEnabled: z.boolean(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type ServerToClientFrame = z.infer<typeof ServerToClientFrameSchema>;

const MENTION_REGEX = /(?<=^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![a-zA-Z0-9_-])/g;

export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const match of text.matchAll(MENTION_REGEX)) {
    const raw = match[1];
    if (!raw) continue;
    const normalized = raw.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      handles.push(normalized);
    }
  }
  return handles;
}

export function canonicalPacketSigningInput(
  packet: Omit<P2pPacket, "signature">,
): string {
  return JSON.stringify({
    version: packet.version,
    id: packet.id,
    fromNodeId: packet.fromNodeId,
    fromHandle: packet.fromHandle,
    toNodeId: packet.toNodeId,
    timestamp: packet.timestamp,
    nonce: packet.nonce,
    envelope: {
      alg: packet.envelope.alg,
      iv: packet.envelope.iv,
      tag: packet.envelope.tag,
      ciphertext: packet.envelope.ciphertext,
    },
  });
}
