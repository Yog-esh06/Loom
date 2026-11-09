import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class AgentDefinition:
    name: str
    role: str
    capabilities: tuple[str, ...]
    tools: tuple[str, ...] = ()


AGENTS = (
    AgentDefinition("orchestrator", "Routes requests and coordinates bounded work.", ("planning",)),
    AgentDefinition("document_intelligence", "Summarizes provided text and extracts evidence-backed actions.", ("summarize", "extract_tasks")),
    AgentDefinition("task_planning", "Turns extracted actions into proposed tasks.", ("propose_tasks",)),
    AgentDefinition("research", "Produces a mock research plan without external network access.", ("research_plan",)),
    AgentDefinition("workspace_organization", "Recommends workspace organization.", ("organize",)),
    AgentDefinition("meeting_communication", "Drafts meeting summaries and status updates.", ("meeting_summary",)),
    AgentDefinition("quality_verification", "Validates result structure and approval boundaries.", ("validate",)),
    AgentDefinition("security_permission", "Checks workspace scope before execution.", ("authorize",)),
)


def public_registry() -> list[dict[str, Any]]:
    return [
        {
            "name": agent.name,
            "role": agent.role,
            "capabilities": list(agent.capabilities),
            "tools": list(agent.tools),
        }
        for agent in AGENTS
    ]


def build_plan(request: str) -> list[str]:
    lowered = request.lower()
    if any(word in lowered for word in ("task", "action item", "follow-up", "follow up")):
        return ["security_permission", "document_intelligence", "task_planning", "quality_verification"]
    if any(word in lowered for word in ("research", "investigate")):
        return ["security_permission", "research", "quality_verification"]
    if "organize" in lowered or "organization" in lowered:
        return ["security_permission", "workspace_organization", "quality_verification"]
    if any(word in lowered for word in ("meeting", "status update", "announcement")):
        return ["security_permission", "meeting_communication", "quality_verification"]
    return ["security_permission", "document_intelligence", "quality_verification"]


class AgentTaskProposal(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    status: Literal["todo", "in_progress", "done"] = "todo"
    priority: Literal["low", "medium", "high"] = "medium"


class AgentEnvelope(BaseModel):
    correlation_id: str
    sender_agent: str
    recipient_agent: str
    message_type: str
    payload: dict[str, Any]


def run_specialist(agent_name: str, state: dict[str, Any]) -> dict[str, Any]:
    source = state.get("source_text", "")
    if agent_name == "security_permission":
        return {"authorized": True, "scope": "request workspace only", "tools": []}
    if agent_name == "document_intelligence":
        action_items = [
            re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
            for line in source.splitlines()
            if re.search(r"\b(?:todo|action|follow[- ]?up|task|owner|due)\b", line, re.I)
        ]
        return {
            "summary": " ".join(source.split())[:600]
            or "No source text was supplied. The deterministic provider does not invent workspace content.",
            "action_items": action_items[:10],
            "evidence": [item[:240] for item in action_items[:10]],
        }
    if agent_name == "task_planning":
        return {
            "proposed_tasks": [
                AgentTaskProposal(title=item[:240]).model_dump()
                for item in state.get("action_items", [])
                if item
            ]
        }
    if agent_name == "research":
        return {
            "summary": "Research provider is not configured. No external sources were accessed.",
            "sources": [],
            "limitations": ["This is a deterministic mock result, not research."],
        }
    if agent_name == "workspace_organization":
        return {
            "recommendations": [],
            "limitations": ["No workspace inventory was supplied to this specialist."],
        }
    if agent_name == "meeting_communication":
        return {
            "summary": " ".join(source.split())[:600] or "No meeting notes were supplied.",
            "draft": "",
            "decisions": [],
        }
    if agent_name == "quality_verification":
        proposed = [AgentTaskProposal.model_validate(item).model_dump() for item in state.get("proposed_tasks", [])]
        evidence = state.get("evidence", [])
        unsupported = [item["title"] for item in proposed if item["title"] not in evidence]
        if unsupported:
            raise ValueError(f"Unsupported task proposals: {unsupported}")
        return {"valid": True, "findings": [], "checked_proposals": len(proposed)}
    raise ValueError(f"Agent is not registered: {agent_name}")


def encode_result(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)
