import asyncio
import base64
import json
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.agents import AgentEnvelope, build_plan, encode_result, public_registry, run_specialist
from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import (
    AgentApproval,
    AgentExecution,
    AgentExecutionEvent,
    AgentMessage,
    Comment,
    Document,
    DocumentUpdate,
    DocumentVersion,
    Project,
    Task,
    User,
    Workspace,
    WorkspaceMember,
)
from app.schemas import (
    AgentDecision,
    AgentRequest,
    CommentCreate,
    DocumentCreate,
    ProjectCreate,
    TaskCreate,
    TaskPatch,
    TokenOut,
    UserCreate,
    UserLogin,
    UserOut,
    VersionCreate,
    WorkspaceCreate,
)
from app.security import create_access_token, decode_access_token, hash_password, verify_password

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("loom")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.environment.lower() != "development" and settings.secret_key == "development-only-change-me":
        raise RuntimeError("SECRET_KEY must be configured outside development")
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="LOOM API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Correlation-ID"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cache-Control"] = "no-store"
    return response


def authenticated_user(
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> User:
    if authorization is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        user_id = decode_access_token(token)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


def require_workspace(db: Session, workspace_id: str, user: User) -> WorkspaceMember:
    membership = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return membership


def project_for_member(db: Session, project_id: str, user: User) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    require_workspace(db, project.workspace_id, user)
    return project


def document_for_member(db: Session, document_id: str, user: User) -> tuple[Document, Project]:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    project = project_for_member(db, document.project_id, user)
    return document, project


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/v1/auth/register", response_model=TokenOut, status_code=201)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="Email is already registered")
    user = User(email=email, name=payload.name.strip(), password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"access_token": create_access_token(user.id), "user": user}


@app.post("/api/v1/auth/login", response_model=TokenOut)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email.strip().lower()))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return {"access_token": create_access_token(user.id), "user": user}


@app.get("/api/v1/auth/me", response_model=UserOut)
def me(user: User = Depends(authenticated_user)):
    return user


@app.get("/api/v1/workspaces")
def list_workspaces(db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    rows = db.scalars(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at)
    ).all()
    return [{"id": row.id, "name": row.name, "created_at": row.created_at} for row in rows]


@app.post("/api/v1/workspaces", status_code=201)
def create_workspace(
    payload: WorkspaceCreate, db: Session = Depends(get_db), user: User = Depends(authenticated_user)
):
    workspace = Workspace(name=payload.name.strip(), created_by=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.commit()
    db.refresh(workspace)
    return {"id": workspace.id, "name": workspace.name, "role": "owner"}


@app.get("/api/v1/workspaces/{workspace_id}/projects")
def list_projects(workspace_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    require_workspace(db, workspace_id, user)
    rows = db.scalars(select(Project).where(Project.workspace_id == workspace_id).order_by(Project.created_at)).all()
    return rows


@app.post("/api/v1/workspaces/{workspace_id}/projects", status_code=201)
def create_project(
    workspace_id: str,
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    require_workspace(db, workspace_id, user)
    project = Project(workspace_id=workspace_id, name=payload.name.strip(), description=payload.description)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@app.get("/api/v1/projects/{project_id}/documents")
def list_documents(project_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    project_for_member(db, project_id, user)
    return db.scalars(select(Document).where(Document.project_id == project_id).order_by(Document.created_at)).all()


@app.post("/api/v1/projects/{project_id}/documents", status_code=201)
def create_document(
    project_id: str,
    payload: DocumentCreate,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    project_for_member(db, project_id, user)
    document = Document(project_id=project_id, title=payload.title.strip(), created_by=user.id)
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


@app.get("/api/v1/documents/{document_id}")
def get_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    document, _ = document_for_member(db, document_id, user)
    updates = db.scalars(
        select(DocumentUpdate).where(DocumentUpdate.document_id == document_id).order_by(DocumentUpdate.id)
    ).all()
    return {
        "id": document.id,
        "project_id": document.project_id,
        "title": document.title,
        "updates": [base64.b64encode(update.update).decode("ascii") for update in updates],
    }


@app.get("/api/v1/projects/{project_id}/tasks")
def list_tasks(project_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    project_for_member(db, project_id, user)
    return db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.created_at.desc())).all()


@app.post("/api/v1/projects/{project_id}/tasks", status_code=201)
def create_task(
    project_id: str,
    payload: TaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    project_for_member(db, project_id, user)
    task = Task(project_id=project_id, created_by=user.id, **payload.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.get("/api/v1/tasks/{task_id}")
def get_task(task_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    project_for_member(db, task.project_id, user)
    return task


@app.patch("/api/v1/tasks/{task_id}")
def patch_task(
    task_id: str,
    payload: TaskPatch,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    project_for_member(db, task.project_id, user)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(task, key, value)
    db.commit()
    db.refresh(task)
    return task


@app.post("/api/v1/documents/{document_id}/comments", status_code=201)
def create_comment(
    document_id: str,
    payload: CommentCreate,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    document_for_member(db, document_id, user)
    comment = Comment(document_id=document_id, author_id=user.id, body=payload.body)
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


@app.get("/api/v1/documents/{document_id}/comments")
def list_comments(document_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    document_for_member(db, document_id, user)
    return db.scalars(select(Comment).where(Comment.document_id == document_id).order_by(Comment.created_at)).all()


@app.post("/api/v1/documents/{document_id}/versions", status_code=201)
def create_version(
    document_id: str,
    payload: VersionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    document_for_member(db, document_id, user)
    try:
        snapshot = base64.b64decode(payload.snapshot, validate=True)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Snapshot must be base64-encoded bytes") from exc
    version = DocumentVersion(
        document_id=document_id, author_id=user.id, label=payload.label.strip(), snapshot=snapshot
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return {"id": version.id, "document_id": version.document_id, "label": version.label, "created_at": version.created_at}


@app.get("/api/v1/documents/{document_id}/history")
def document_history(document_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)):
    document_for_member(db, document_id, user)
    versions = db.scalars(
        select(DocumentVersion).where(DocumentVersion.document_id == document_id).order_by(DocumentVersion.created_at.desc())
    ).all()
    return [{"id": version.id, "label": version.label, "author_id": version.author_id, "created_at": version.created_at} for version in versions]


@app.get("/api/v1/agents", dependencies=[Depends(authenticated_user)])
def agent_registry():
    return {"provider": "deterministic-mock", "agents": public_registry()}


@app.post("/api/v1/agent-executions", status_code=202)
async def create_agent_execution(
    payload: AgentRequest,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    require_workspace(db, payload.workspace_id, user)
    if payload.project_id:
        project = project_for_member(db, payload.project_id, user)
        if project.workspace_id != payload.workspace_id:
            raise HTTPException(status_code=404, detail="Project not found")
    elif any(word in payload.request.lower() for word in ("task", "action item", "follow-up", "follow up")):
        raise HTTPException(status_code=422, detail="Select a project before requesting task proposals")
    execution = AgentExecution(workspace_id=payload.workspace_id, requested_by=user.id, request=payload.request)
    db.add(execution)
    db.flush()
    plan = build_plan(payload.request)
    for agent_name in plan:
        db.add(
            AgentExecutionEvent(
                execution_id=execution.id,
                agent_name=agent_name,
                status="assigned",
                detail="Assigned by the orchestrator.",
            )
        )
    db.commit()
    asyncio.create_task(run_agent_execution(execution.id, payload.model_dump()))
    return {"id": execution.id, "status": "planned", "plan": plan}


async def run_agent_execution(execution_id: str, payload: dict):
    with SessionLocal() as db:
        execution = db.get(AgentExecution, execution_id)
        if execution is None or execution.status == "cancelled":
            return
        execution.status = "running"
        db.commit()
        try:
            await asyncio.sleep(0)
            plan = build_plan(payload["request"])
            state = {"source_text": (payload.get("document_text") or "").strip()}
            for index, agent_name in enumerate(plan):
                if execution.status == "cancelled":
                    return
                event = db.scalar(
                    select(AgentExecutionEvent).where(
                        AgentExecutionEvent.execution_id == execution_id,
                        AgentExecutionEvent.agent_name == agent_name,
                    )
                )
                if event is not None:
                    event.status = "running"
                    db.commit()
                output = run_specialist(agent_name, state)
                next_agent = plan[index + 1] if index + 1 < len(plan) else "orchestrator"
                envelope = AgentEnvelope(
                    correlation_id=execution_id,
                    sender_agent=agent_name,
                    recipient_agent=next_agent,
                    message_type=f"{agent_name}.result",
                    payload=output,
                )
                db.add(
                    AgentMessage(
                        execution_id=execution_id,
                        correlation_id=envelope.correlation_id,
                        sender_agent=envelope.sender_agent,
                        recipient_agent=envelope.recipient_agent,
                        message_type=envelope.message_type,
                        payload=json.dumps(envelope.payload),
                    )
                )
                state.update(output)
                if agent_name == "quality_verification":
                    state["validation"] = output
                if event is not None:
                    event.status = "completed"
                    event.detail = "Structured output passed to the next owner."
                db.commit()
            result = {
                "provider": "deterministic-mock",
                "label": "Mock output, not model-generated",
                "request": payload["request"],
                "summary": state.get("summary", " ".join(state.get("limitations", [])) or "No summary was produced."),
                "proposed_tasks": state.get("proposed_tasks", []),
                "validation": state.get("validation", {"valid": False, "findings": ["Quality validation did not run."]}),
                "project_id": payload.get("project_id"),
                "requires_approval": bool(state.get("proposed_tasks")),
            }
            execution.result = encode_result(result)
            execution.status = "awaiting_approval" if result["requires_approval"] else "completed"
            if result["proposed_tasks"]:
                db.add(
                    AgentApproval(
                        execution_id=execution_id,
                        workspace_id=execution.workspace_id,
                        proposed_tasks=json.dumps(result["proposed_tasks"]),
                    )
                )
            db.commit()
        except Exception:
            logger.exception("Agent execution failed: %s", execution_id)
            execution.status = "failed"
            execution.error = "The execution failed. See server logs for the correlation id."
            for event in db.scalars(
                select(AgentExecutionEvent).where(
                    AgentExecutionEvent.execution_id == execution_id,
                    AgentExecutionEvent.status.in_(("assigned", "running")),
                )
            ).all():
                event.status = "failed"
                event.detail = execution.error
            db.commit()


@app.get("/api/v1/agent-executions")
def list_agent_executions(
    workspace_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    require_workspace(db, workspace_id, user)
    executions = db.scalars(
        select(AgentExecution).where(AgentExecution.workspace_id == workspace_id).order_by(AgentExecution.created_at.desc())
    ).all()
    return [
        {
            "id": item.id,
            "request": item.request,
            "status": item.status,
            "result": json.loads(item.result) if item.result else None,
            "error": item.error,
            "created_at": item.created_at,
        }
        for item in executions
    ]


@app.get("/api/v1/agent-executions/{execution_id}")
def get_agent_execution(
    execution_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)
):
    execution = db.get(AgentExecution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    require_workspace(db, execution.workspace_id, user)
    events = db.scalars(
        select(AgentExecutionEvent).where(AgentExecutionEvent.execution_id == execution_id).order_by(AgentExecutionEvent.created_at)
    ).all()
    messages = db.scalars(
        select(AgentMessage).where(AgentMessage.execution_id == execution_id).order_by(AgentMessage.created_at)
    ).all()
    return {
        "id": execution.id,
        "status": execution.status,
        "request": execution.request,
        "result": json.loads(execution.result) if execution.result else None,
        "error": execution.error,
        "events": [{"agent": e.agent_name, "status": e.status, "detail": e.detail} for e in events],
        "messages": [
            {
                "correlation_id": message.correlation_id,
                "sender_agent": message.sender_agent,
                "recipient_agent": message.recipient_agent,
                "message_type": message.message_type,
                "payload": json.loads(message.payload),
            }
            for message in messages
        ],
    }


@app.post("/api/v1/agent-executions/{execution_id}/cancel")
def cancel_agent_execution(
    execution_id: str, db: Session = Depends(get_db), user: User = Depends(authenticated_user)
):
    execution = db.get(AgentExecution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    require_workspace(db, execution.workspace_id, user)
    if execution.status not in {"planned", "requested", "running"}:
        raise HTTPException(status_code=409, detail="Execution can no longer be cancelled")
    execution.status = "cancelled"
    for event in db.scalars(
        select(AgentExecutionEvent).where(
            AgentExecutionEvent.execution_id == execution_id,
            AgentExecutionEvent.status.in_(("assigned", "running")),
        )
    ).all():
        event.status = "cancelled"
        event.detail = "Cancelled by a workspace member."
    db.commit()
    return {"id": execution.id, "status": execution.status}


@app.get("/api/v1/agent-approvals")
def list_agent_approvals(
    workspace_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    require_workspace(db, workspace_id, user)
    rows = db.scalars(
        select(AgentApproval).where(AgentApproval.workspace_id == workspace_id).order_by(AgentApproval.created_at.desc())
    ).all()
    return [
        {
            "id": row.id,
            "execution_id": row.execution_id,
            "status": row.status,
            "proposed_tasks": json.loads(row.proposed_tasks),
            "created_at": row.created_at,
        }
        for row in rows
    ]


@app.post("/api/v1/agent-approvals/{approval_id}")
def decide_agent_approval(
    approval_id: str,
    payload: AgentDecision,
    db: Session = Depends(get_db),
    user: User = Depends(authenticated_user),
):
    approval = db.get(AgentApproval, approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    require_workspace(db, approval.workspace_id, user)
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail="Approval has already been reviewed")
    execution = db.get(AgentExecution, approval.execution_id)
    if execution is None:
        raise HTTPException(status_code=409, detail="Execution no longer exists")
    destination_project = None
    proposals = json.loads(approval.proposed_tasks)
    if payload.decision == "approve":
        result = json.loads(execution.result or "{}")
        project_id = result.get("project_id")
        if not project_id:
            raise HTTPException(status_code=422, detail="The proposal has no project destination")
        destination_project = project_for_member(db, project_id, user)
        if destination_project.workspace_id != approval.workspace_id:
            raise HTTPException(status_code=404, detail="Project not found")
    next_status = "approved" if payload.decision == "approve" else "rejected"
    claim = db.execute(
        update(AgentApproval)
        .where(AgentApproval.id == approval_id, AgentApproval.status == "pending")
        .values(status=next_status, reviewed_by=user.id, reviewed_at=datetime.now(timezone.utc))
    )
    if claim.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="Approval has already been reviewed")
    if payload.decision == "approve" and destination_project is not None:
        for proposal in proposals:
            db.add(
                Task(
                    project_id=destination_project.id,
                    created_by=user.id,
                    title=proposal["title"],
                    description="Created from an approved agent proposal.",
                    status=proposal["status"],
                    priority=proposal["priority"],
                )
            )
        execution.status = "completed"
    else:
        execution.status = "rejected"
    db.commit()
    return {"id": approval.id, "status": next_status}


class RoomManager:
    def __init__(self):
        self.rooms: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, document_id: str, socket: WebSocket):
        await socket.accept()
        self.rooms[document_id].add(socket)

    def disconnect(self, document_id: str, socket: WebSocket):
        self.rooms[document_id].discard(socket)
        if not self.rooms[document_id]:
            self.rooms.pop(document_id, None)

    async def broadcast(self, document_id: str, message: dict, exclude: WebSocket | None = None):
        for socket in list(self.rooms.get(document_id, set())):
            if socket is not exclude:
                await socket.send_json(message)


rooms = RoomManager()


@app.websocket("/api/v1/documents/{document_id}/sync")
async def sync_document(socket: WebSocket, document_id: str, token: str = Query(...)):
    with SessionLocal() as db:
        try:
            user_id = decode_access_token(token)
        except jwt.InvalidTokenError:
            await socket.close(code=4401, reason="Invalid token")
            return
        user = db.get(User, user_id)
        document = db.get(Document, document_id)
        project = db.get(Project, document.project_id) if document else None
        if user is None or project is None or not db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == project.workspace_id,
                WorkspaceMember.user_id == user.id,
            )
        ):
            await socket.close(code=4404, reason="Document not found")
            return
    await rooms.connect(document_id, socket)
    await rooms.broadcast(document_id, {"type": "presence", "user_id": user_id, "state": "joined"}, exclude=socket)
    try:
        while True:
            message = await socket.receive_json()
            message_type = message.get("type")
            if message_type == "update":
                try:
                    update = base64.b64decode(message["update"], validate=True)
                except (KeyError, ValueError, TypeError):
                    await socket.send_json({"type": "error", "detail": "Invalid base64 update"})
                    continue
                if len(update) > 1_000_000:
                    await socket.send_json({"type": "error", "detail": "Update exceeds 1 MB"})
                    continue
                with SessionLocal() as db:
                    db.add(DocumentUpdate(document_id=document_id, update=update, author_id=user_id))
                    db.commit()
                await rooms.broadcast(
                    document_id, {"type": "update", "update": message["update"], "user_id": user_id}, exclude=socket
                )
                await socket.send_json({"type": "ack"})
            elif message_type == "presence":
                await rooms.broadcast(
                    document_id, {"type": "presence", "user_id": user_id, "state": message.get("state", {})}, exclude=socket
                )
            else:
                await socket.send_json({"type": "error", "detail": "Unsupported message type"})
    except WebSocketDisconnect:
        rooms.disconnect(document_id, socket)
        await rooms.broadcast(document_id, {"type": "presence", "user_id": user_id, "state": "left"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
