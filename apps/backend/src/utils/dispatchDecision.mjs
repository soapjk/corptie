const messages = {
  MAILBOX_MESSAGE_NOT_FOUND:"邮箱消息记录不存在，无法派发。",
  MAILBOX_MESSAGE_IGNORED:"消息已被忽略。",
  MAILBOX_MESSAGE_ADOPTED:"消息已由其他执行回合接管。",
  RECIPIENT_SESSION_NOT_FOUND:"接收会话不存在。",
  RECIPIENT_SESSION_DELETED:"接收会话已删除。",
  RECIPIENT_SESSION_ARCHIVED:"接收会话已归档。",
  MAILBOX_ROUTE_UNAVAILABLE:"接收会话没有有效的活动绑定。",
  MAILBOX_PAUSED:"接收会话的邮箱已暂停自动处理。",
  MAILBOX_PASSIVE_MESSAGE:"通知或回执默认不单独启动执行。",
  SESSION_ROLE_UNBOUND:"接收会话没有绑定可用的执行角色。",
  SESSION_BUSY:"接收会话正在执行其他指令，当前消息等待执行结束。",
  SESSION_STATE_UNAVAILABLE:"无法确认接收会话的旧执行是否已经结束。",
  SESSION_RECOVERING:"正在核对或恢复接收会话的旧执行。",
  WORKSPACE_TRANSITION_IN_PROGRESS:"接收会话正在切换工作区或恢复绑定。",
  WORKTREE_MUTATION_IN_PROGRESS:"接收会话的工作区正在执行 Git 集成或同步。",
  CHANNEL_BATCH_WAIT:"正在等待同一通道的消息合批。",
  OPERATION_CLAIM_UNAVAILABLE:"消息已被其他处理路径领取或取消。"
};
export const dispatchReady = () => ({allowed:true,kind:"ready",code:null,message:null});
export function dispatchBlocked(code,kind="waiting",message=null) {
  return {allowed:false,kind,code,message:message ?? messages[code] ?? code};
}
