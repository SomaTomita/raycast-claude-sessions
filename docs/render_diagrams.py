"""Renders the diagrams embedded in README.md.

Run from the repository root:

    uv run --with diagrams --python 3.12 docs/render_diagrams.py

Requires Graphviz (`brew install graphviz`).
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.generic.storage import Storage
from diagrams.onprem.client import Client
from diagrams.programming.flowchart import Action, Database, Decision, Document, StartEnd
from diagrams.programming.framework import React
from diagrams.programming.language import Typescript

INK = "#1F2328"
BLUE = "#2F6FB3"
ORANGE = "#C4622D"
GREY = "#8B949E"

# A solid background: GitHub shows these images unchanged, and dark ink on a transparent
# background is unreadable in dark mode.
GRAPH_ATTR = {
    "bgcolor": "#FFFFFF",
    "fontcolor": INK,
    "fontname": "Helvetica",
    "fontsize": "15",
    "pad": "0.3",
    "nodesep": "0.35",
    "ranksep": "0.7",
}
NODE_ATTR = {"fontcolor": INK, "fontname": "Helvetica", "fontsize": "11"}
EDGE_ATTR = {"fontcolor": INK, "fontname": "Helvetica", "fontsize": "10"}

READ = Edge(color=BLUE)
WRITE = Edge(color=ORANGE)


def yes(label: str = "yes") -> Edge:
    return Edge(label=label, color=BLUE, fontcolor=INK)


def no(label: str = "no") -> Edge:
    return Edge(label=label, color=ORANGE, fontcolor=INK)


def architecture() -> None:
    with Diagram(
        "Claude Code Sessions",
        filename="docs/architecture",
        show=False,
        direction="LR",
        graph_attr={**GRAPH_ATTR, "splines": "spline"},
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
            windows = Typescript("windows.ts / focus.ts\nWindow menu, 15s")
            activate = Typescript("activate.ts\nJXA, by pid")
            resume = Typescript("resume.ts")

        with Cluster("Targets"):
            iterm = Client("iTerm2 tab")
            editor = Client("Zed window")

        registry_file >> READ >> registry
        cli >> READ >> agents
        transcripts >> READ >> transcript
        prompt_log >> READ >> prompts
        registry >> Edge(color=BLUE, label="ps parent chain") >> host

        for reader in (registry, agents, transcript, prompts, host):
            reader >> READ >> merge

        merge >> Edge(color=BLUE, label="30s / ⌘R") >> list_view
        list_view >> READ >> detail
        list_view >> WRITE >> goto

        goto >> WRITE >> windows
        goto >> WRITE >> activate
        goto >> Edge(color=ORANGE, label="nothing hosts it") >> resume

        windows >> WRITE >> editor
        activate >> WRITE >> editor
        resume >> Edge(color=ORANGE, label="write text") >> iterm


def reaching_a_live_session() -> None:
    """↩ on a row whose process is alive. See goToSession() in src/lib/goto.ts."""
    with Diagram(
        "↩ · reaching a live session",
        filename="docs/flow-live",
        show=False,
        direction="LR",
        graph_attr=GRAPH_ATTR,
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        start = StartEnd("live session")
        host_kind = Decision("what hosts it?")
        activate = Action("activate the host pid\n(never launches)")

        with Cluster("scriptable terminal"):
            tab = Action("select the tab\nwhose tty matches")

        with Cluster("editor"):
            window = Decision("a window or workspace\nholds this directory?")
            switch = Action("switch to it via\nthe Window menu")

        start >> Edge(color=BLUE) >> host_kind
        host_kind >> Edge(label="iTerm2 / Terminal", color=BLUE, fontcolor=INK) >> tab
        host_kind >> Edge(label="Zed / VS Code", color=BLUE, fontcolor=INK) >> window
        host_kind >> Edge(label="anything else", color=GREY, fontcolor=INK) >> activate
        window >> yes() >> switch
        window >> no() >> activate


def resuming_a_session() -> None:
    """↩ on a row nothing can reach. See the resume path in components/session-actions.tsx."""
    with Diagram(
        "↩ · nothing hosts it",
        filename="docs/flow-resume",
        show=False,
        direction="LR",
        graph_attr=GRAPH_ATTR,
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        resume = Action("claude --resume in iTerm2\n(⌘⇧↩ for every session\nof the project)")

        with Cluster("history row"):
            history = StartEnd("no process,\nonly a transcript")

        with Cluster("window gone row"):
            gone = StartEnd("process alive,\nnowhere to jump")
            stale = Decision("quit the process\nholding it?")
            sigterm = Action("SIGTERM first:\none writer\nper transcript")
            nothing = StartEnd("nothing happens")

        with Cluster("background agent row"):
            background = StartEnd("claude --bg job")
            attach = Action("copy\nclaude attach <id>")

        history >> Edge(color=ORANGE) >> resume

        gone >> Edge(color=ORANGE) >> stale
        stale >> yes("confirm") >> sigterm
        stale >> Edge(label="cancel", color=GREY, fontcolor=INK) >> nothing
        sigterm >> Edge(color=ORANGE) >> resume

        background >> Edge(color=GREY) >> attach


if __name__ == "__main__":
    architecture()
    reaching_a_live_session()
    resuming_a_session()
    print("wrote docs/architecture.png, docs/flow-live.png, docs/flow-resume.png")
