"""BATCH-16 — a minimal Google ADK agent served over A2A, the live SUT for `gth eval`'s
`adk-agent` target.

One LlmAgent with a single deterministic tool (`lookup_shipment`) that returns
**verbatim, paraphrase-proof marker codes** the model would never invent. Those markers are
what the eval's `must_contain` assertions grade on — the eval cannot see A2A tool traces
(`must_call` is a parse-time error for this target), so a marker the tool alone emits is the
proof the tool actually ran.

Run (via run-adk-eval.sh):
    ADK_A2A_PORT=<port> uvicorn adk_agent:app --host 127.0.0.1 --port <port>

The port is read from ADK_A2A_PORT so the agent card's rpc `url` (built by `to_a2a`) matches the
port uvicorn binds — the `@a2a-js/sdk` client resolves the card at
`<url>/.well-known/agent-card.json` then POSTs JSON-RPC `message/send` to the card's `url`.
"""

from __future__ import annotations

import os

from google.adk.agents import LlmAgent
from google.adk.a2a.utils.agent_to_a2a import to_a2a

# Model for the SUT agent — cheap Gemini over AI Studio (GOOGLE_API_KEY). The lifecycle script
# forces GOOGLE_GENAI_USE_VERTEXAI=FALSE so this resolves against AI Studio, not Vertex.
MODEL = os.environ.get("ADK_A2A_MODEL", "gemini-flash-lite-latest")
HOST = os.environ.get("ADK_A2A_HOST", "127.0.0.1")
PORT = int(os.environ.get("ADK_A2A_PORT", "41539"))


def lookup_shipment(tracking_id: str) -> dict:
    """Look up the delivery status of a shipment by its tracking id.

    Args:
        tracking_id: The shipment tracking id to look up (e.g. "TKH-9").

    Returns:
        A record with the exact status code, carrier, and destination for the shipment.
    """
    # Deterministic, verbatim markers — the agent has no way to produce these strings except by
    # actually calling this tool. The eval asserts must_contain on them.
    records = {
        "TKH-9": {
            "tracking_id": "TKH-9",
            "status_code": "SHIP-DELIVERED-7Q",
            "carrier": "Takahe Freight",
            "destination": "Wellington",
        },
        "TKH-42": {
            "tracking_id": "TKH-42",
            "status_code": "SHIP-INTRANSIT-3B",
            "carrier": "Takahe Freight",
            "destination": "Auckland",
        },
    }
    return records.get(
        tracking_id,
        {"tracking_id": tracking_id, "status_code": "SHIP-UNKNOWN-0", "carrier": "n/a"},
    )


root_agent = LlmAgent(
    name="shipping_agent",
    model=MODEL,
    description="A shipping assistant that looks up shipment delivery status by tracking id.",
    instruction=(
        "You are a shipping assistant. When the user asks about a shipment, call the "
        "`lookup_shipment` tool with the tracking id and report back the EXACT `status_code` "
        "string the tool returns, verbatim, along with the carrier and destination. Never invent "
        "a status code — always use the tool's returned value. If the user gives you a codeword "
        "or fact to remember, remember it and repeat it back exactly when later asked."
    ),
    tools=[lookup_shipment],
)

# Starlette ASGI app; uvicorn serves it. `to_a2a` mounts the agent card at
# /.well-known/agent-card.json and the JSON-RPC handler at / (card.url == http://HOST:PORT/).
app = to_a2a(root_agent, host=HOST, port=PORT, protocol="http")
