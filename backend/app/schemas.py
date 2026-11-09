from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    email: str = Field(max_length=320)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=10, max_length=128)


class UserLogin(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    name: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=5000)


class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=10000)
    status: str = Field(default="todo", pattern="^(todo|in_progress|done)$")
    priority: str = Field(default="medium", pattern="^(low|medium|high)$")


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=10000)
    status: str | None = Field(default=None, pattern="^(todo|in_progress|done)$")
    priority: str | None = Field(default=None, pattern="^(low|medium|high)$")


class AgentRequest(BaseModel):
    workspace_id: str
    request: str = Field(min_length=1, max_length=10000)
    project_id: str | None = None
    document_text: str | None = Field(default=None, max_length=50000)


class AgentDecision(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10000)


class VersionCreate(BaseModel):
    label: str = Field(default="", max_length=160)
    snapshot: str = Field(min_length=1, max_length=2_000_000)
