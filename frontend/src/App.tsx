import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
type User = { id: string; email: string; name: string };
type Workspace = { id: string; name: string };
type Project = { id: string; workspace_id: string; name: string; description: string };
type DocumentItem = { id: string; title: string; project_id: string };
type Task = { id: string; title: string; description: string; status: string; priority: string };
type AgentExecution = {
  id: string;
  request: string;
  status: string;
  created_at: string;
  result: null | { label: string; summary: string; proposed_tasks: { title: string }[] };
};
type Approval = { id: string; status: string; proposed_tasks: { title: string }[] };

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("loom-token") ?? "");
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tab, setTab] = useState<"overview" | "board" | "agents">("overview");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [online, setOnline] = useState(true);
  const [createKind, setCreateKind] = useState<"workspace" | "project" | "document" | null>(null);
  const [createName, setCreateName] = useState("");
  const [agentSource, setAgentSource] = useState<{ documentId: string; title: string; text: string } | null>(null);

  const refreshWorkspace = useCallback(async (workspaceId: string) => {
    const [nextProjects, nextExecutions, nextApprovals] = await Promise.all([
      request<Project[]>(`/api/v1/workspaces/${workspaceId}/projects`, token),
      request<AgentExecution[]>(`/api/v1/agent-executions?workspace_id=${workspaceId}`, token),
      request<Approval[]>(`/api/v1/agent-approvals?workspace_id=${workspaceId}`, token),
    ]);
    setProjects(nextProjects);
    setExecutions(nextExecutions);
    setApprovals(nextApprovals);
  }, [token]);

  const refreshProject = useCallback(async (projectId: string) => {
    const [nextDocuments, nextTasks] = await Promise.all([
      request<DocumentItem[]>(`/api/v1/projects/${projectId}/documents`, token),
      request<Task[]>(`/api/v1/projects/${projectId}/tasks`, token),
    ]);
    setDocuments(nextDocuments);
    setTasks(nextTasks);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    request<User>("/api/v1/auth/me", token)
      .then(async (me) => {
        setUser(me);
        const rows = await request<Workspace[]>("/api/v1/workspaces", token);
        setWorkspaces(rows);
        if (rows[0]) {
          setWorkspace(rows[0]);
          await refreshWorkspace(rows[0].id);
        }
      })
      .catch(() => {
        localStorage.removeItem("loom-token");
        setToken("");
        setUser(null);
        setWorkspaces([]);
        setProjects([]);
        setDocuments([]);
        setTasks([]);
        setExecutions([]);
        setApprovals([]);
        setAgentSource(null);
      });
  }, [token, refreshWorkspace]);

  useEffect(() => {
    if (project) void refreshProject(project.id).catch(showError);
  }, [project, refreshProject]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setInterval(() => {
      void refreshWorkspace(workspace.id).catch(showError);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [workspace, refreshWorkspace]);

  const showError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "Something went wrong.");
    window.setTimeout(() => setError(""), 5000);
  }, []);

  const captureEditorText = useCallback((text: string) => {
    editorTextRef.current = text;
  }, []);

  const openProject = useCallback((item: Project) => {
    setProject(item);
    setDocument(null);
    setAgentSource(null);
    setDocuments([]);
    setTasks([]);
    setTab("overview");
  }, []);

  const openAgentsFromDocument = useCallback((source: DocumentItem, text: string) => {
    setAgentSource({ documentId: source.id, title: source.title, text });
    setDocument(null);
    setTab("agents");
  }, []);

  function beginCreation(kind: "workspace" | "project" | "document") {
    setCreateName("");
    setCreateKind(kind);
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const path = authMode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login";
      const payload = {
        email: String(data.get("email")),
        password: String(data.get("password")),
        ...(authMode === "register" ? { name: String(data.get("name")) } : {}),
      };
      const result = await request<{ access_token: string }> (path, "", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      localStorage.setItem("loom-token", result.access_token);
      setToken(result.access_token);
    } catch (reason) {
      showError(reason);
    }
  }

  async function submitCreation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    if (!name || !createKind) return;
    try {
      if (createKind === "workspace") {
        const created = await request<Workspace>("/api/v1/workspaces", token, {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        const rows = await request<Workspace[]>("/api/v1/workspaces", token);
        setWorkspaces(rows);
        setWorkspace(created);
        setProject(null);
        setDocument(null);
        setAgentSource(null);
        setDocuments([]);
        setTasks([]);
        await refreshWorkspace(created.id);
      } else if (createKind === "project" && workspace) {
        const created = await request<Project>(`/api/v1/workspaces/${workspace.id}/projects`, token, {
          method: "POST",
          body: JSON.stringify({ name, description: "" }),
        });
        await refreshWorkspace(workspace.id);
        setProject(created);
        setDocument(null);
        setAgentSource(null);
        setDocuments([]);
        setTasks([]);
      } else if (createKind === "document" && project) {
        const created = await request<DocumentItem>(`/api/v1/projects/${project.id}/documents`, token, {
          method: "POST",
          body: JSON.stringify({ title: name }),
        });
        setDocuments((current) => [...current, created]);
        setDocument(created);
        setAgentSource(null);
      } else {
        throw new Error("Choose a workspace before creating this item.");
      }
      setCreateKind(null);
    } catch (reason) {
      showError(reason);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const created = await request<Task>(`/api/v1/projects/${project.id}/tasks`, token, {
        method: "POST",
        body: JSON.stringify({
          title: data.get("title"),
          description: data.get("description"),
          priority: data.get("priority"),
        }),
      });
      setTasks((current) => [created, ...current]);
      form.reset();
    } catch (reason) {
      showError(reason);
    }
  }

  async function changeTask(task: Task, status: string) {
    try {
      const updated = await request<Task>(`/api/v1/tasks/${task.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      showError(reason);
    }
  }

  async function askAgents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const created = await request<{ id: string }>("/api/v1/agent-executions", token, {
        method: "POST",
        body: JSON.stringify({
          workspace_id: workspace.id,
          project_id: project?.id ?? null,
          request: data.get("request"),
          document_text: agentSource?.text ?? (document ? editorTextRef.current : null),
        }),
      });
      setNotice(`Execution ${created.id.slice(0, 8)} started`);
      form.reset();
      await refreshWorkspace(workspace.id);
    } catch (reason) {
      showError(reason);
    }
  }

  async function decideApproval(approval: Approval, decision: "approve" | "reject") {
    try {
      await request(`/api/v1/agent-approvals/${approval.id}`, token, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setNotice(decision === "approve" ? "Proposed tasks created." : "Proposal rejected.");
      if (workspace) await refreshWorkspace(workspace.id);
      if (project) await refreshProject(project.id);
    } catch (reason) {
      showError(reason);
    }
  }

  function signOut() {
    localStorage.removeItem("loom-token");
    setToken("");
    setUser(null);
    setWorkspace(null);
    setProject(null);
    setDocument(null);
    setWorkspaces([]);
    setProjects([]);
    setDocuments([]);
    setTasks([]);
    setExecutions([]);
    setApprovals([]);
    setAgentSource(null);
  }

  if (!token || !user) {
    return (
      <main className="auth-page">
        <div className="auth-aside">
          <div className="brand"><span className="brand-mark">l</span> LOOM</div>
          <div className="auth-quote">
            <p className="eyebrow">A quieter way to work together</p>
            <h1>Good work<br />takes shape<br /><em>in company.</em></h1>
            <p>Shared notes, clear next steps, and room to think.</p>
            <span className="auth-note">A workspace for the work that matters.</span>
          </div>
          <div className="auth-orbit"><span /><span /><span /><i>l</i></div>
        </div>
        <section className="auth-form-wrap">
          <form className="auth-form" onSubmit={signIn}>
            <p className="eyebrow">{authMode === "register" ? "Get started" : "Welcome back"}</p>
            <h2>{authMode === "register" ? "Make room for good work." : "Pick up where you left off."}</h2>
            <p className="muted">A shared space for your team's ideas and momentum.</p>
            {authMode === "register" && <label>Your name<input name="name" required maxLength={120} placeholder="Alex Morgan" /></label>}
            <label>Work email<input name="email" type="email" required placeholder="you@company.com" /></label>
            <label>Password<input name="password" type="password" required minLength={10} placeholder="At least 10 characters" /></label>
            <button className="button primary wide">{authMode === "register" ? "Create your account" : "Sign in"} <span>↗</span></button>
            <p className="switch-auth">
              {authMode === "register" ? "Already have an account?" : "New to LOOM?"}{" "}
              <button type="button" className="text-button" onClick={() => setAuthMode(authMode === "register" ? "login" : "register")}>
                {authMode === "register" ? "Sign in" : "Create account"}
              </button>
            </p>
          </form>
        </section>
        {error && <div className="toast error">{error}</div>}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">l</span> LOOM</div>
        <div className="workspace-picker">
          <span className="workspace-symbol">{workspace?.name.slice(0, 1).toUpperCase() ?? "L"}</span>
          <span className="workspace-name">{workspace?.name ?? "Your workspace"}<small>Workspace</small></span>
          <span className="chevron">⌄</span>
        </div>
        <div className="sidebar-label">YOUR SPACES <button onClick={() => beginCreation("workspace")} aria-label="Add workspace">＋</button></div>
        <div className="workspace-list">
          {workspaces.map((item) => (
            <button key={item.id} className={`workspace-row ${item.id === workspace?.id ? "selected" : ""}`} onClick={async () => {
              setWorkspace(item); setProject(null); setDocument(null); setAgentSource(null); setDocuments([]); setTasks([]); setTab("overview");
              await refreshWorkspace(item.id).catch(showError);
            }}>
              <span className="tiny-square">{item.name.slice(0, 1).toUpperCase()}</span>{item.name}
            </button>
          ))}
          {!workspaces.length && <span className="sidebar-hint">Create a workspace to begin.</span>}
        </div>
        <div className="sidebar-label project-label">PROJECTS <button onClick={() => beginCreation("project")} aria-label="Add project">＋</button></div>
        <nav className="project-nav">
          {projects.map((item) => (
            <button key={item.id} className={`project-link ${project?.id === item.id ? "active" : ""}`} onClick={() => {
              openProject(item);
            }}><span className="project-dot" />{item.name}</button>
          ))}
          {!projects.length && <span className="sidebar-hint">Projects will appear here.</span>}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
          <div className="user-meta"><strong>{user.name}</strong><small>{user.email}</small></div>
          <button className="icon-button" title="Sign out" onClick={signOut}>↗</button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="crumbs"><span>{workspace?.name ?? "Workspace"}</span><b>/</b><strong>{document?.title ?? project?.name ?? "Overview"}</strong></div>
          <div className="topbar-right">
            <span className={`sync-pill ${online ? "online" : ""}`}><i />{document ? (online ? "All changes saved" : "Reconnecting") : "Workspace ready"}</span>
            <span className="avatar small">{user.name.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <section className="page-content">
          {document ? (
            <DocumentEditor
              document={document}
              token={token}
              onClose={() => setDocument(null)}
              onOnline={setOnline}
              onText={captureEditorText}
              onAgentHelp={openAgentsFromDocument}
              onError={showError}
            />
          ) : !workspace ? (
            <EmptyState onClick={() => beginCreation("workspace")} action="Create a workspace" title="Start with a shared space." text="Bring your team, projects, and working notes together." />
          ) : !project ? (
            <WorkspaceHome workspace={workspace} projects={projects} executions={executions} onCreate={() => beginCreation("project")} onOpen={openProject} onTab={setTab} tab={tab} />
          ) : (
            <>
              <div className="page-heading">
                <div><p className="eyebrow">PROJECT SPACE</p><h1>{project.name}<span className="status-dot" /></h1><p className="muted">{project.description || "A focused space for the team's shared work."}</p></div>
                <div className="heading-actions"><span className="avatar" title={user.name}>{user.name.slice(0, 1).toUpperCase()}</span></div>
              </div>
              <div className="tabs">
                <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
                <button className={tab === "board" ? "active" : ""} onClick={() => setTab("board")}>Tasks <span className="tab-count">{tasks.length}</span></button>
                <button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agent activity</button>
              </div>
              {tab === "overview" && (
                <div className="overview-grid">
                  <section className="panel document-panel">
                    <div className="panel-heading"><div><p className="eyebrow">SHARED NOTES</p><h2>Documents</h2></div><button className="button subtle" onClick={() => beginCreation("document")}>＋ New document</button></div>
                    <div className="document-list">
                      {documents.map((item, index) => <button key={item.id} className="document-row" onClick={() => { setAgentSource(null); setDocument(item); }}>
                        <span className="doc-icon">{index % 2 ? "▤" : "¶"}</span><span className="doc-name"><strong>{item.title}</strong><small>Shared document · Open to collaborate</small></span><span className="row-arrow">↗</span>
                      </button>)}
                      {!documents.length && <div className="empty-inline"><span>¶</span><strong>Nothing written yet</strong><small>Create a shared doc to start thinking together.</small><button onClick={() => beginCreation("document")}>Create first document</button></div>}
                    </div>
                  </section>
                  <section className="panel task-panel">
                    <div className="panel-heading"><div><p className="eyebrow">WHAT'S MOVING</p><h2>Next up</h2></div><button className="text-button" onClick={() => setTab("board")}>View board ↗</button></div>
                    <TaskList tasks={tasks.slice(0, 4)} onChange={changeTask} compact />
                    {!tasks.length && <div className="empty-inline small-empty"><strong>Clear for now</strong><small>Add a task when there's something to move forward.</small></div>}
                    <TaskForm onSubmit={createTask} compact />
                  </section>
                  <AgentCallout onClick={() => setTab("agents")} />
                </div>
              )}
              {tab === "board" && <TaskBoard tasks={tasks} onChange={changeTask} onSubmit={createTask} />}
              {tab === "agents" && <AgentCenter workspace={workspace} executions={executions} approvals={approvals} token={token} sourceDocumentTitle={agentSource?.title} onSubmit={askAgents} onDecision={decideApproval} />}
            </>
          )}
        </section>
        <footer className="footer"><span>LOOM <i>·</i> Shared work, in sync.</span><span>Made for thoughtful teams</span></footer>
      </main>
      {createKind && <div className="create-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setCreateKind(null);
      }}>
        <form className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={submitCreation}>
          <p className="eyebrow">MAKE SPACE FOR IT</p>
          <h2 id="create-title">{createKind === "workspace" ? "A new workspace" : createKind === "project" ? "A new project" : "A new document"}</h2>
          <label htmlFor="create-name">{createKind === "document" ? "Document title" : "Name"}</label>
          <input id="create-name" autoFocus required maxLength={createKind === "document" ? 240 : 160} value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={createKind === "workspace" ? "The studio" : createKind === "project" ? "A good idea" : "Untitled notes"} />
          <div className="create-actions"><button type="button" className="button outline" onClick={() => setCreateKind(null)}>Cancel</button><button type="submit" className="button primary">Create <span>↗</span></button></div>
        </form>
      </div>}
      {(error || notice) && <div className={`toast ${error ? "error" : ""}`} onClick={() => { setError(""); setNotice(""); }}>{error || notice}<button>×</button></div>}
    </div>
  );
}

const editorTextRef = { current: "" };

function EmptyState({ title, text, action, onClick }: { title: string; text: string; action: string; onClick: () => void }) {
  return <div className="empty-state"><div className="empty-mark">l</div><p className="eyebrow">A PLACE TO BEGIN</p><h1>{title}</h1><p className="muted">{text}</p><button className="button primary" onClick={onClick}>{action} <span>↗</span></button></div>;
}

function WorkspaceHome({ workspace, projects, executions, onCreate, onOpen, onTab, tab }: {
  workspace: Workspace; projects: Project[]; executions: AgentExecution[]; onCreate: () => void;
  onOpen: (project: Project) => void; onTab: (tab: "overview" | "agents" | "board") => void; tab: string;
}) {
  return (
    <>
      <div className="page-heading workspace-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{workspace.name}</h1><p className="muted">A thoughtful place for work to take shape.</p></div><button className="button primary" onClick={onCreate}>＋ New project</button></div>
      <div className="tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => onTab("overview")}>Overview</button><button onClick={() => onTab("agents")}>Agent activity</button></div>
      {tab === "agents" ? <div className="overview-grid single"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">RECENT WORK</p><h2>Agent executions</h2></div></div><ExecutionList executions={executions} /></div></div> : (
        <div className="project-grid">
          {projects.map((project, index) => <button className="project-card" key={project.id} onClick={() => onOpen(project)}>
            <div className="card-symbol">{["◌", "◇", "＋", "⌘"][index % 4]}</div><span className="project-card-status">ACTIVE <i /></span><h2>{project.name}</h2><p>{project.description || "A shared project space for notes, plans, and the next step."}</p><div className="project-card-foot"><span className="avatar tiny">{project.name.slice(0, 1).toUpperCase()}</span><span className="avatar tiny alt">Y</span><small>Open project</small><b>↗</b></div>
          </button>)}
          <button className="new-project-card" onClick={onCreate}><span>＋</span><strong>Start a new project</strong><small>Give a good idea some room.</small></button>
        </div>
      )}
      <div className="workspace-note"><span className="note-icon">✳</span><div><strong>Make progress visible.</strong><p>Share a document, map the work, or ask your agents to find a thread worth pulling.</p></div><button className="text-button" onClick={() => onTab("agents")}>Meet your agents ↗</button></div>
    </>
  );
}

function TaskForm({ onSubmit, compact = false }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; compact?: boolean }) {
  return <form className={`task-form ${compact ? "compact" : ""}`} onSubmit={onSubmit}>
    <div className="form-main"><input name="title" required maxLength={240} placeholder="Add a task to move forward…" /><input name="description" className="description-input" placeholder="Add a little context (optional)" /></div>
    <select name="priority" aria-label="Priority" defaultValue="medium"><option value="low">Low priority</option><option value="medium">Medium priority</option><option value="high">High priority</option></select>
    <button className="button dark" type="submit">Add task <span>↗</span></button>
  </form>;
}

function TaskList({ tasks, onChange, compact = false }: { tasks: Task[]; onChange: (task: Task, status: string) => void; compact?: boolean }) {
  return <div className={`task-list ${compact ? "compact" : ""}`}>{tasks.map((task) => <div className="task-row" key={task.id}>
    <button className={`task-check ${task.status === "done" ? "checked" : ""}`} aria-label="Mark task done" onClick={() => onChange(task, task.status === "done" ? "todo" : "done")}>{task.status === "done" ? "✓" : ""}</button>
    <span className="task-copy"><strong className={task.status === "done" ? "done" : ""}>{task.title}</strong>{!compact && <small>{task.description || "No description"}</small>}</span>
    <span className={`priority ${task.priority}`}>{task.priority}</span>
    <select aria-label="Task status" value={task.status} onChange={(event) => onChange(task, event.target.value)}>
      <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
    </select>
  </div>)}</div>;
}

function TaskBoard({ tasks, onChange, onSubmit }: { tasks: Task[]; onChange: (task: Task, status: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const columns = [{ id: "todo", title: "To do" }, { id: "in_progress", title: "In progress" }, { id: "done", title: "Done" }];
  return <div className="board-view"><TaskForm onSubmit={onSubmit} /> <div className="board-columns">{columns.map((column) => <section className="board-column" key={column.id}>
    <div className="column-heading"><span><i className={`column-dot ${column.id}`} />{column.title}</span><small>{tasks.filter((task) => task.status === column.id).length}</small></div>
    {tasks.filter((task) => task.status === column.id).map((task) => <article className="task-card" key={task.id}><span className={`priority ${task.priority}`}>{task.priority}</span><h3>{task.title}</h3><p>{task.description || "No description added."}</p><select value={task.status} aria-label={`Move ${task.title}`} onChange={(event) => onChange(task, event.target.value)}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></article>)}
    {!tasks.some((task) => task.status === column.id) && <div className="column-empty">No work here yet.</div>}
  </section>)}</div></div>;
}

function AgentCallout({ onClick }: { onClick: () => void }) {
  return <button className="agent-callout" onClick={onClick}><div className="agent-orbit"><i>l</i><span /><span /><span /></div><div><p className="eyebrow">A LITTLE HELP, WHEN YOU NEED IT</p><h2>Let the team of agents<br />take a first pass.</h2><p>Summaries, action items, or a status draft. Always reviewed by you.</p></div><span className="callout-arrow">↗</span></button>;
}

function ExecutionList({ executions }: { executions: AgentExecution[] }) {
  if (!executions.length) return <div className="empty-inline"><strong>No runs yet</strong><small>Agent plans and results will appear here.</small></div>;
  return <div className="execution-list">{executions.map((run) => <article className="execution-row" key={run.id}><span className="execution-glyph">✳</span><div><strong>{run.request}</strong>  <small>{run.result?.label ?? "Preparing agents"} · {new Date(run.created_at).toLocaleString()}</small>{run.result && <p>{run.result.summary}</p>}</div><span className={`execution-status ${run.status}`}>{run.status.replaceAll("_", " ")}</span></article>)}</div>;
}

function AgentCenter({ workspace, executions, approvals, token, sourceDocumentTitle, onSubmit, onDecision }: {
  workspace: Workspace; executions: AgentExecution[]; approvals: Approval[]; token: string;
  sourceDocumentTitle?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDecision: (approval: Approval, decision: "approve" | "reject") => void;
}) {
  const [agents, setAgents] = useState<{ name: string; role: string; capabilities: string[] }[]>([]);
  useEffect(() => {
    request<{ agents: typeof agents }>("/api/v1/agents", token).then((result) => setAgents(result.agents)).catch(() => setAgents([]));
  }, [token]);
  return <div className="agent-layout">
    <div className="agent-main">
      <div className="agent-intro"><div className="agent-orbit large"><i>l</i><span /><span /><span /></div><div><p className="eyebrow">LOOM AGENT TEAM</p><h2>Good support. Clear boundaries.</h2><p>Specialists work in sequence, check one another's output, and bring decisions back to you.</p></div></div>
      <form className="agent-prompt" onSubmit={onSubmit}><label htmlFor="agent-request">What would you like a hand with?</label><textarea id="agent-request" name="request" required minLength={1} placeholder="Summarize these notes and pull out the follow-up tasks…" /><div><span>{sourceDocumentTitle ? `Source: ${sourceDocumentTitle} · Mock provider` : "Mock provider · No external model configured"}</span><button className="button dark">Plan a run <span>↗</span></button></div></form>
      <section className="panel approvals-panel"><div className="panel-heading"><div><p className="eyebrow">YOUR CALL</p><h2>Approval queue</h2></div><span className="count-badge">{approvals.filter((item) => item.status === "pending").length}</span></div>
        {approvals.filter((item) => item.status === "pending").map((approval) => <div className="approval-card" key={approval.id}><div className="approval-top"><span className="approval-mark">✓</span><div><strong>Proposed tasks</strong><small>Review before these are added to the workspace.</small></div></div><ul>{approval.proposed_tasks.map((task, index) => <li key={`${task.title}-${index}`}>{task.title}</li>)}</ul><div className="approval-actions"><button className="button outline" onClick={() => onDecision(approval, "reject")}>Decline</button><button className="button primary" onClick={() => onDecision(approval, "approve")}>Approve tasks <span>↗</span></button></div></div>)}
        {!approvals.some((item) => item.status === "pending") && <div className="empty-inline"><span>✓</span><strong>Nothing waiting on you</strong><small>Agent-proposed actions need your approval before anything changes.</small></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRACEABLE WORK</p><h2>Recent executions</h2></div></div><ExecutionList executions={executions} /></section>
    </div>
    <aside className="agent-side"><section className="panel agent-roster"><p className="eyebrow">THE SPECIALISTS</p><h2>One team, distinct roles.</h2><div className="roster-list">{agents.map((agent, index) => <div className="roster-item" key={agent.name}><span className={`roster-icon tone-${index % 4}`}>{["◎", "¶", "↗", "⌘"][index % 4]}</span><div><strong>{agent.name.replaceAll("_", " ")}</strong><small>{agent.role}</small></div><i className="roster-status" /></div>)}</div></section><div className="safety-note"><span>⌑</span><p><strong>People stay in control.</strong><br />Agents can suggest. Only approved actions change shared work.</p></div></aside>
  </div>;
}

function DocumentEditor({ document, token, onClose, onOnline, onText, onAgentHelp, onError }: {
  document: DocumentItem; token: string; onClose: () => void;
  onOnline: (online: boolean) => void; onText: (text: string) => void;
  onAgentHelp: (document: DocumentItem, text: string) => void; onError: (error: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [peers, setPeers] = useState(1);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const textRef = useRef<Y.Text | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const remoteOrigin = useRef({});
  onText(text);

  useEffect(() => {
    let disposed = false;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    docRef.current = ydoc;
    textRef.current = ytext;
    const persistence = new IndexeddbPersistence(`loom-document-${document.id}`, ydoc);
    const handler = (update: Uint8Array, origin: unknown) => {
      const current = ytext.toString();
      setText(current);
      onText(current);
      if (origin === remoteOrigin.current || origin === "server-load") return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "update", update: toBase64(update) }));
      }
    };
    ydoc.on("update", handler);
    persistence.whenSynced.then(async () => {
      if (disposed) return;
      try {
        const initial = await request<{ updates: string[] }>(`/api/v1/documents/${document.id}`, token);
        for (const update of initial.updates) Y.applyUpdate(ydoc, fromBase64(update), "server-load");
        if (disposed) return;
        const wsUrl = new URL(`${API.replace(/^http/, "ws")}/api/v1/documents/${document.id}/sync`);
        wsUrl.searchParams.set("token", token);
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;
        socket.onopen = () => {
          onOnline(true);
          socket.send(JSON.stringify({ type: "update", update: toBase64(Y.encodeStateAsUpdate(ydoc)) }));
          socket.send(JSON.stringify({ type: "presence", state: { name: "online" } }));
        };
        socket.onclose = () => onOnline(false);
        socket.onerror = () => onOnline(false);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "update") Y.applyUpdate(ydoc, fromBase64(message.update), remoteOrigin.current);
          if (message.type === "presence" && message.state === "joined") setPeers((count) => count + 1);
          if (message.type === "presence" && message.state === "left") setPeers((count) => Math.max(1, count - 1));
        };
        setReady(true);
      } catch (reason) {
        onError(reason);
      }
    }).catch(onError);
    return () => {
      disposed = true;
      socketRef.current?.close();
      ydoc.off("update", handler);
      persistence.destroy();
      ydoc.destroy();
      docRef.current = null;
      textRef.current = null;
    };
  }, [document.id, token, onOnline, onText, onError]);

  function editText(value: string) {
    const ytext = textRef.current;
    const element = textarea.current;
    if (!ytext || !element) return;
    const previous = ytext.toString();
    let start = 0;
    while (start < previous.length && start < value.length && previous[start] === value[start]) start++;
    let oldEnd = previous.length;
    let newEnd = value.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    ydocTransact(() => {
      if (oldEnd > start) ytext.delete(start, oldEnd - start);
      if (newEnd > start) ytext.insert(start, value.slice(start, newEnd));
    });
  }

  function applyMarkup(opening: string, closing = opening) {
    const element = textarea.current;
    const ytext = textRef.current;
    if (!element || !ytext) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = element.value.slice(start, end);
    docRef.current?.transact(() => {
      if (end > start) ytext.delete(start, end - start);
      ytext.insert(start, `${opening}${selected}${closing}`);
    });
    const cursor = start + opening.length + selected.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(selected ? start + opening.length : cursor, cursor);
    });
  }

  function insertHeading() {
    const element = textarea.current;
    const ytext = textRef.current;
    if (!element || !ytext) return;
    const position = element.selectionStart;
    docRef.current?.transact(() => ytext.insert(position, "\n## "));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(position + 4, position + 4);
    });
  }

  function ydocTransact(fn: () => void) {
    docRef.current?.transact(fn);
  }

  function toBase64(value: Uint8Array) {
    let binary = "";
    value.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }
  function fromBase64(value: string) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }

  return <div className="editor-view">
    <div className="editor-toolbar"><button className="text-button" onClick={onClose}>← Project</button><span className={`sync-pill ${ready ? "online" : ""}`}><i />{ready ? "Synced" : "Loading document"}</span><span className="editor-peer">◉ {peers} here</span><button className="text-button" onClick={() => onAgentHelp(document, text)}>Ask agents ↗</button><button className="button outline" onClick={() => window.print()}>Export</button></div>
    <div className="editor-paper"><div className="editor-meta"><span>SHARED DOCUMENT</span><span>Autosaves as you write</span></div><h1>{document.title}</h1>    <div className="editor-tools"><button aria-label="Bold selection" onClick={() => applyMarkup("**")}>B</button><button aria-label="Italic selection" onClick={() => applyMarkup("*")}>I</button><button aria-label="Insert heading" onClick={insertHeading}>H₂</button><span /><small>PLAIN TEXT · YJS SYNC</small></div><textarea ref={textarea} className="document-input" value={text} onChange={(event) => editText(event.target.value)} placeholder="Start with a thought. The rest can follow…" spellCheck /></div>
    <div className="editor-footnote">Changes are stored as Yjs CRDT updates. Offline edits are kept in this browser and merge on reconnect.</div>
  </div>;
}

export default App;
