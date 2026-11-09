import base64
import os
import time

os.environ["DATABASE_URL"] = "sqlite:///./test_loom.db"
os.environ["SECRET_KEY"] = "loom-test-secret-key-with-at-least-32-bytes"

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.db import Base, engine
from app.main import app


def register(client: TestClient, email: str):
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "name": "Test User", "password": "a-secure-test-password"},
    )
    assert response.status_code == 201
    return response.json()["access_token"]


def auth(token: str):
    return {"Authorization": f"Bearer {token}"}


def test_workspace_isolation_and_task_lifecycle():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        owner = register(client, "owner@example.test")
        outsider = register(client, "outsider@example.test")
        workspace = client.post("/api/v1/workspaces", headers=auth(owner), json={"name": "Studio"}).json()
        project = client.post(
            f"/api/v1/workspaces/{workspace['id']}/projects",
            headers=auth(owner),
            json={"name": "Field notes", "description": "Shared work"},
        ).json()
        denied = client.get(
            f"/api/v1/projects/{project['id']}/tasks",
            headers=auth(outsider),
        )
        assert denied.status_code == 404

        created = client.post(
            f"/api/v1/projects/{project['id']}/tasks",
            headers=auth(owner),
            json={"title": "Review notes", "description": "Before Friday", "priority": "high"},
        )
        assert created.status_code == 201
        task = created.json()
        updated = client.patch(
            f"/api/v1/tasks/{task['id']}",
            headers=auth(owner),
            json={"status": "in_progress"},
        )
        assert updated.status_code == 200
        assert updated.json()["status"] == "in_progress"


def test_agent_proposal_requires_human_approval():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        token = register(client, "agent-user@example.test")
        workspace = client.post("/api/v1/workspaces", headers=auth(token), json={"name": "Studio"}).json()
        project = client.post(
            f"/api/v1/workspaces/{workspace['id']}/projects",
            headers=auth(token),
            json={"name": "Launch"},
        ).json()
        created = client.post(
            "/api/v1/agent-executions",
            headers=auth(token),
            json={
                "workspace_id": workspace["id"],
                "project_id": project["id"],
                "request": "Extract tasks from these meeting notes",
                "document_text": "- Action: review launch checklist",
            },
        )
        assert created.status_code == 202
        execution_id = created.json()["id"]
        details = client.get(f"/api/v1/agent-executions/{execution_id}", headers=auth(token)).json()
        for _ in range(20):
            if details["status"] not in {"planned", "requested", "running"}:
                break
            time.sleep(0.01)
            details = client.get(f"/api/v1/agent-executions/{execution_id}", headers=auth(token)).json()
        assert details["status"] == "awaiting_approval"
        assert details["result"]["label"] == "Mock output, not model-generated"
        assert details["result"]["validation"]["valid"] is True
        assert [message["sender_agent"] for message in details["messages"]] == [
            "security_permission",
            "document_intelligence",
            "task_planning",
            "quality_verification",
        ]
        assert all(event["status"] == "completed" for event in details["events"])
        assert client.get(
            f"/api/v1/projects/{project['id']}/tasks", headers=auth(token)
        ).json() == []
        approvals = client.get(
            f"/api/v1/agent-approvals?workspace_id={workspace['id']}", headers=auth(token)
        ).json()
        assert len(approvals) == 1
        approval_id = approvals[0]["id"]
        reviewed = client.post(
            f"/api/v1/agent-approvals/{approval_id}",
            headers=auth(token),
            json={"decision": "approve"},
        )
        assert reviewed.status_code == 200
        tasks = client.get(f"/api/v1/projects/{project['id']}/tasks", headers=auth(token)).json()
        assert [task["title"] for task in tasks] == ["Action: review launch checklist"]
        duplicate = client.post(
            f"/api/v1/agent-approvals/{approval_id}",
            headers=auth(token),
            json={"decision": "approve"},
        )
        assert duplicate.status_code == 409


def test_document_updates_persist_and_websocket_requires_membership():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        owner = register(client, "doc-owner@example.test")
        outsider = register(client, "doc-outsider@example.test")
        workspace = client.post("/api/v1/workspaces", headers=auth(owner), json={"name": "Studio"}).json()
        project = client.post(
            f"/api/v1/workspaces/{workspace['id']}/projects",
            headers=auth(owner),
            json={"name": "Notes"},
        ).json()
        document = client.post(
            f"/api/v1/projects/{project['id']}/documents",
            headers=auth(owner),
            json={"title": "Shared notes"},
        ).json()
        update = base64.b64encode(b"opaque-yjs-update").decode("ascii")
        with client.websocket_connect(
            f"/api/v1/documents/{document['id']}/sync?token={owner}"
        ) as websocket:
            websocket.send_json({"type": "update", "update": update})
            assert websocket.receive_json()["type"] == "ack"
        persisted = client.get(f"/api/v1/documents/{document['id']}", headers=auth(owner)).json()
        assert persisted["updates"] == [update]
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(f"/api/v1/documents/{document['id']}/sync?token={outsider}") as websocket:
                websocket.receive_json()
        assert error.value.code == 4404


def test_invalid_authentication_is_rejected():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        response = client.get("/api/v1/workspaces")
        assert response.status_code == 401


def test_local_frontend_origin_is_allowed_by_cors():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/auth/register",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
