"""Renders the diagrams embedded in README.md.

Run from the repository root:

    uv run --with diagrams --python 3.12 docs/diagrams.py

Requires Graphviz (`brew install graphviz`).
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.generic.storage import Storage
from diagrams.onprem.client import Client
from diagrams.programming.flowchart import Action, Database, Decision, Document, StartEnd
from diagrams.programming.framework import React
from diagrams.programming.language import Typescript

GRAPH_ATTR = {
    "fontsize": "16",
    "bgcolor": "transparent",
    "pad": "0.4",
    "splines": "spline",
}
NODE_ATTR = {"fontsize": "12"}
EDGE_ATTR = {"fontsize": "11"}

READ = Edge(color="#4A7DBE")
WRITE = Edge(color="#D97757")
POLL = Edge(color="#4A7DBE", style="dashed")


def architecture() -> None:
    with Diagram(
        "Claude Code Sessions",
        filename="docs/architecture",
        show=False,
        direction="LR",
        graph_attr=GRAPH_ATTR,
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        with Cluster("Sources (read-only)"):
            registry_file = Storage("~/.claude/sessions\n<pid>.json")
            transcripts = Database("~/.claude/projects\n<session>.jsonl")
            prompt_log = Document("~/.claude/history.jsonl")
            cli = Action("claude agents\n--all --json")

        with Cluster("Read layer"):
            registry = Typescript("registry.ts\n3s poll")
            agents = Typescript("agents.ts\n45s TTL")
            transcript = Typescript("transcript.ts\nmtime memo")
            prompts = Typescript("prompts.ts\nmessages.ts")
            host = Typescript("host.ts")
            merge = Typescript("sessions.ts\nmerge + state")

        with Cluster("Raycast command"):
            list_view = React("sessions.tsx")
            detail = React("session-detail\ntranscript-view")

        with Cluster("Action layer"):
            goto = Typescript("goto.ts")
            windows = Typescript("windows.ts / focus.ts\n15s window scan")
            activate = Typescript("activate.ts\nJXA / pid")
            resume = Typescript("resume.ts")

        with Cluster("Targets"):
            iterm = Client("iTerm2 tab\n(tty match)")
            editor = Client("Zed window\n(AXRaise)")

        registry_file >> READ >> registry
        cli >> READ >> agents
        transcripts >> READ >> transcript
        prompt_log >> READ >> prompts
        registry >> Edge(color="#4A7DBE", label="ps parent chain") >> host

        agents >> READ >> merge
        registry >> READ >> merge
        transcript >> READ >> merge
        prompts >> READ >> merge
        host >> READ >> merge

        merge >> Edge(color="#4A7DBE", label="30s / ⌘R") >> list_view
        list_view >> READ >> detail
        list_view >> WRITE >> goto
        goto >> WRITE >> windows
        goto >> WRITE >> activate
        goto >> Edge(color="#D97757", label="no host left") >> resume

        windows >> WRITE >> editor
        activate >> WRITE >> editor
        resume >> Edge(color="#D97757", label="write text") >> iterm


def go_to_session() -> None:
    """Mirrors goToSession() in src/lib/goto.ts and the resume path in session-actions.tsx."""
    with Diagram(
        "Go to Session",
        filename="docs/go-to-session",
        show=False,
        direction="LR",
        graph_attr={**GRAPH_ATTR, "ranksep": "1.0", "nodesep": "0.5"},
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        start = StartEnd("↩ on a row")
        is_background = Decision("background\nagent?")
        is_live = Decision("live\nprocess?")
        window_gone = Decision("editor window\ngone?")
        host_kind = Decision("host kind?")
        has_stale = Decision("stale process\nholds it?")

        copy_attach = Action("copy\nclaude attach <id>")
        tab = Action("select the tab\nwhose tty matches")
        raise_window = Action("AXRaise\nthat window")
        activate = Action("activate host pid\n(never launches)")
        sigterm = Action("SIGTERM,\nthen resume")
        resume = Action("resume in iTerm2 tabs\n(⌘⇧↩ for the whole project)")

        start >> is_background
        is_background >> Edge(label="yes", color="#D97757") >> copy_attach
        is_background >> Edge(label="no", color="#4A7DBE") >> is_live

        is_live >> Edge(label="no", color="#D97757") >> resume
        is_live >> Edge(label="yes", color="#4A7DBE") >> window_gone

        window_gone >> Edge(label="yes", color="#D97757") >> has_stale
        window_gone >> Edge(label="no", color="#4A7DBE") >> host_kind

        nothing = StartEnd("nothing happens")
        has_stale >> Edge(label="confirm", color="#D97757") >> sigterm
        has_stale >> Edge(label="cancel", color="#9AA0A6") >> nothing
        sigterm >> WRITE >> resume

        host_kind >> Edge(label="iTerm2 / Terminal", color="#4A7DBE") >> tab
        host_kind >> Edge(label="editor: window\nshows the cwd", color="#4A7DBE") >> raise_window
        host_kind >> Edge(label="editor: no match,\nor other app", color="#4A7DBE") >> activate


if __name__ == "__main__":
    architecture()
    go_to_session()
    print("wrote docs/architecture.png and docs/go-to-session.png")
