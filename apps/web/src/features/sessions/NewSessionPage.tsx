import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createSession, getBootstrap } from "../../lib/api/client";

export function NewSessionPage() {
  const navigate = useNavigate();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: getBootstrap });
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("medium");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [approvalPolicy, setApprovalPolicy] = useState("on-request");
  const [prompt, setPrompt] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: createSession,
    onSuccess: (result) => navigate(`/sessions/${encodeURIComponent(result.session.id)}`)
  });

  useEffect(() => {
    const defaults = bootstrap.data?.creation.defaults;
    if (!defaults) return;
    setAgent(defaults.agent);
    setWorkspace(defaults.workspace ?? "");
    setModel(defaults.codexModel ?? "");
    setReasoningLevel(defaults.reasoningLevel ?? "medium");
    setSandbox(defaults.sandbox);
    setApprovalPolicy(defaults.approvalPolicy);
  }, [bootstrap.data]);

  if (bootstrap.isPending) return <div className="surface loading-state">正在读取 Mac 配置…</div>;
  if (bootstrap.isError || !bootstrap.data) return <div className="surface error-state"><h1>无法新建 Session</h1><p>无法读取可信工作区和默认值。</p></div>;
  const creation = bootstrap.data.creation;
  const models = creation.models[agent];

  return (
    <section className="new-session-page">
      <header>
        <Link className="back-link" to="/sessions">← Sessions</Link>
        <h1>新建 Session</h1>
        <p>工作区与模型均由这台 Mac 提供，网页不能输入任意路径。</p>
      </header>
      <form className="surface new-session-form" onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ workspace, agent, model: model || undefined, reasoningLevel, sandbox, approvalPolicy, prompt });
      }}>
        <label>Agent<select onChange={(event) => {
          const next = event.target.value as "codex" | "claude";
          setAgent(next);
          setModel(next === "codex" ? (creation.defaults.codexModel ?? "") : (creation.defaults.claudeModel ?? ""));
        }} value={agent}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
        <label>可信工作区<select required onChange={(event) => setWorkspace(event.target.value)} value={workspace}>
          <option disabled value="">Mac 上没有可信工作区</option>
          {creation.workspaces.map((entry) => <option key={entry.path} value={entry.path}>{entry.name} — {entry.path}</option>)}
        </select></label>
        <label>模型<select onChange={(event) => setModel(event.target.value)} value={model}>
          <option value="">Mac 默认模型</option>
          {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        {agent === "codex" ? <label>推理级别<select onChange={(event) => setReasoningLevel(event.target.value)} value={reasoningLevel}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option>
        </select></label> : null}
        <label>Sandbox<select onChange={(event) => setSandbox(event.target.value)} value={sandbox}>
          <option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Danger full access</option>
        </select></label>
        <label>Approval Policy<select onChange={(event) => setApprovalPolicy(event.target.value)} value={approvalPolicy}>
          <option value="on-request">On request</option><option value="ask-risky">Ask risky</option><option value="on-failure">On failure</option><option value="never">Never ask</option>
        </select></label>
        <label className="new-session-prompt">首个任务<textarea maxLength={100000} onChange={(event) => setPrompt(event.target.value)} placeholder="描述要继续完成的开发任务…" required rows={5} value={prompt} /></label>
        {mutation.isError ? <p className="form-error" role="alert">{mutation.error.message}</p> : null}
        <button className="create-session-button" disabled={!workspace || !prompt.trim() || mutation.isPending} type="submit">
          {mutation.isPending ? "正在 Mac 上创建…" : "创建并开始"}
        </button>
      </form>
    </section>
  );
}
