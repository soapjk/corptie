export type ApiV1Error = {
  apiVersion: "1";
  error: {
    code: string;
    message: string;
    requestId: string | null;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

export type BootstrapResponse = {
  apiVersion: "1";
  environment: "development" | "production";
  serverTime: string;
  eventCursor: number;
  csrfToken: string;
  device: {
    id: string;
    name: string;
    permission: "read-only" | "reply" | "full-control";
    createdAt: string;
    lastSeenAt?: string | null;
  };
  features: Record<string, boolean>;
  preferences: {
    language?: "en" | "zh-Hans";
    theme?: "system" | "light" | "dark";
  };
  creation: {
    workspaces: Array<{ path: string; name: string }>;
    agents: Array<"codex" | "claude">;
    models: Record<"codex" | "claude", Array<{ id: string; name: string }>>;
    defaults: {
      agent: "codex" | "claude";
      workspace?: string | null;
      codexModel?: string | null;
      claudeModel?: string | null;
      reasoningLevel?: string | null;
      sandbox: "workspace-write" | "danger-full-access" | "read-only";
      approvalPolicy: "on-request" | "ask-risky" | "never" | "on-failure";
    };
  };
};

export type AvailableAction = {
  id: string;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  reason?: string | null;
};

export type ApprovalOption = {
  id: string;
  label: string;
  role?: string | null;
  index?: number | null;
  selected?: boolean | null;
};

export type AttentionKind =
  | "high-risk-approval"
  | "collaboration-confirmation"
  | "input-required"
  | "failure"
  | "disconnected"
  | "approval"
  | "completed-unread";

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  priority: number;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  summary: string;
  updatedAt: string;
  contextItemId?: string | null;
  actionContext?: Record<string, unknown>;
  availableActions: AvailableAction[];
};

export type AttentionResponse = {
  apiVersion: "1";
  eventCursor: number;
  count: number;
  runningCount: number;
  items: AttentionItem[];
};

export type SessionStatus = "running" | "blocked" | "complete" | "failed" | "cancelled";

export type SessionSummary = {
  id: string;
  title: string;
  agent: string;
  status: SessionStatus;
  progress: number;
  summary: string;
  suggestedOptions?: ApprovalOption[] | null;
  activityStatus?: string | null;
  updatedAt: string;
  accent: "cyan" | "mint" | "violet" | "amber";
  archived?: boolean;
  pinned?: boolean;
  avatarUrl?: string | null;
  capabilities?: Record<string, boolean> | null;
  availableActions: AvailableAction[];
  external?: {
    provider: string;
    connectionStatus?: string | null;
    currentModel?: string | null;
    currentReasoningLevel?: string | null;
    cwd?: string | null;
    sandbox?: string | null;
    approvalPolicy?: string | null;
  } | null;
};

export type SessionsResponse = {
  apiVersion: "1";
  eventCursor: number;
  sessions: SessionSummary[];
};

export type ThreadItem = {
  id: string;
  turnId: string;
  turnStatus: string;
  type: string;
  title: string;
  text: string;
  options?: ApprovalOption[] | null;
  status?: string | null;
  createdAt?: string | null;
  sourceType?: string | null;
  presentationRole?: string | null;
  presentationText?: string | null;
  collaborationDirection?: string | null;
  collaborationSenderName?: string | null;
  collaborationRecipientName?: string | null;
  collaborationTaskTitle?: string | null;
  collaborationMessageKind?: string | null;
  collaborationProcessingStatus?: string | null;
  collaborationConfirmationId?: string | null;
  collaborationConfirmationStatus?: string | null;
  collaborationAcceptanceCriteria?: string[] | null;
  fileChanges?: Array<{ path: string; kind: string }> | null;
  turnDiff?: string | null;
};

export type SessionDetail = SessionSummary & {
  source?: string | null;
  connectionStatus?: string | null;
  currentModel?: string | null;
  currentReasoningLevel?: string | null;
  cwd?: string | null;
  createdAt: string;
  canSend?: boolean;
  sendUnavailableReason?: string | null;
  turnCount: number;
  items: ThreadItem[];
};

export type SessionResponse = {
  apiVersion: "1";
  eventCursor: number;
  session: SessionDetail;
};
