import { useMutation, useQuery } from "@tanstack/react-query";
import { getTurnDiff, performTurnAction } from "../../lib/api/client";

export function TurnDiffPanel({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const query = useQuery({
    queryKey: ["turn-diff", sessionId, turnId],
    queryFn: () => getTurnDiff(sessionId, turnId),
    enabled: false,
    retry: false
  });
  const action = useMutation({
    retry: false,
    mutationFn: (kind: "undo" | "open-diff" | "open-finder") => performTurnAction(sessionId, turnId, kind)
  });
  const run = (kind: "undo" | "open-diff" | "open-finder") => {
    if (kind === "undo" && !window.confirm("撤销会修改工作区文件。确认撤销这一轮的全部文件变化吗？")) return;
    action.mutate(kind);
  };
  return (
    <details className="turn-diff-panel" onToggle={(event) => {
      if (event.currentTarget.open && !query.data && !query.isFetching) void query.refetch();
    }}>
      <summary>代码差异与本机操作</summary>
      {query.isFetching ? <p>正在读取 Diff…</p> : null}
      {query.data ? <>
        <div className="diff-files">{query.data.files.map((file) => <code key={file}>{file}</code>)}</div>
        <pre className="web-diff"><code>{query.data.diff}</code></pre>
        <div className="turn-action-buttons">
          <button disabled={action.isPending} onClick={() => run("open-finder")} type="button">在 Mac Finder 打开</button>
          <button disabled={action.isPending} onClick={() => run("open-diff")} type="button">用 Mac Diff 工具打开</button>
          <button className="danger-button" disabled={action.isPending} onClick={() => run("undo")} type="button">撤销这一轮</button>
        </div>
      </> : null}
      {query.isError ? <p role="alert">{query.error.message}</p> : null}
      {action.isSuccess ? <p role="status">操作已在 Mac 完成。</p> : null}
      {action.isError ? <p role="alert">{action.error.message}</p> : null}
    </details>
  );
}
