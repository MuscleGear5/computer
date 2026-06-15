"""tts-speak plugin -- speak every assistant response aloud via edge-tts,
and play chimes at lifecycle events for visually impaired users.

Hooks wired:
  - on_session_start      : session_start.sh
  - on_session_end        : session_end.sh
  - pre_llm_call          : chime.sh         (incoming user message)
  - pre_tool_call         : tool_chime.sh    (tool starting, or delegate_chime.sh for delegate_task)
  - post_tool_call        : tool_done.sh     (tool finished)
  - post_api_request      : speak.sh          (speaks all assistant text)

Scripts live in scripts/ and can be edited live -- they take effect immediately
without restarting Hermes. Edit any .sh to change the chime file or behavior.

HOT RELOAD: This plugin auto-reloads when __init__.py changes on disk.
A background daemon polls mtime every 2 seconds and calls importlib.reload().
Hook implementations go through a registry dict so reloaded code takes effect
immediately without re-registering hooks.
"""

from __future__ import annotations

import importlib
import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).parent
_SCRIPTS = _PLUGIN_DIR / "scripts"
_SELF_PATH = Path(__file__).resolve()

_CHIME_SCRIPT = _SCRIPTS / "chime.sh"
_TOOL_CHIME_SCRIPT = _SCRIPTS / "tool_chime.sh"
_DELEGATE_CHIME_SCRIPT = _SCRIPTS / "delegate_chime.sh"
_TOOL_DONE_SCRIPT = _SCRIPTS / "tool_done.sh"
_SESSION_START_SCRIPT = _SCRIPTS / "session_start.sh"
_SESSION_END_SCRIPT = _SCRIPTS / "session_end.sh"
_SPEAK_SCRIPT = _SCRIPTS / "speak.sh"
_COUNCIL_CHIME_SCRIPT = _SCRIPTS / "council_chime.sh"
_COUNCIL_DRONE_SCRIPT = _SCRIPTS / "council_drone.sh"

# Track council drone loop PID so post_tool_call can kill it
_COUNCIL_DRONE_PID: int = 0
_COUNCIL_DRONE_LOCK = threading.Lock()

# Debug log file
_DEBUG_LOG = os.path.join(os.environ.get("HOME", "/data/data/com.termux/files/home"), "tts_speak_debug.log")

# ---------------------------------------------------------------------------
# Registry: hook names -> function references. Hooks call through this so
# the reloaded module's functions are picked up automatically.
# ---------------------------------------------------------------------------
_HOOK_REGISTRY: dict[str, Any] = {}

# Track the last known mtime of __init__.py for hot-reload
_SELF_MTIME: float = 0.0
_RELOAD_LOCK = threading.Lock()


def _debug(msg: str) -> None:
    try:
        with open(_DEBUG_LOG, "a") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Custom compact banner (monkey-patches cli._build_compact_banner)
# ---------------------------------------------------------------------------
def _custom_compact_banner() -> str:
    """Replace Hermes' compact banner with a Computer-branded swarm summary."""
    try:
        from hermes_cli.skin_engine import get_active_skin
        from hermes_cli.banner import format_banner_version_label
        skin = get_active_skin()
    except Exception:
        skin = None

    def _c(key: str, fb: str) -> str:
        return skin.get_color(key, fb) if skin else fb

    border = _c("banner_border", "#4A148C")
    title  = _c("banner_title",  "#CE93D8")
    accent = _c("banner_accent", "#00E676")
    dim    = _c("banner_dim",    "#7B1FA2")
    text   = _c("banner_text",   "#E1BEE7")

    name = skin.get_branding("agent_name", "Computer") if skin else "Computer"
    try:
        version = format_banner_version_label()
    except Exception:
        version = "Hermes Agent"

    return (
        "\n"
        f"  [bold {border}]▓▒░[/] [bold {accent}]{name.upper()}[/] [bold {border}]░▒▓[/]"
        f"  [dim {dim}]·[/] [dim {dim}]{version}[/]\n"
        f"  [{title}]glm-5.2[/] [dim {dim}]⇄[/] [{title}]MiniMax-M3[/]"
        f"  [dim {dim}]· max effort · 1M ctx[/]\n"
        f"  [{accent}]swarm   [/] [dim {dim}]·[/] "
        f"[{text}]council[/] [dim {dim}]·[/] "
        f"[{text}]ruflo[/] [dim {dim}]·[/] "
        f"[{text}]omh[/] [dim {dim}]·[/] "
        f"[{text}]skill-factory[/]\n"
        f"  [{accent}]research[/] [dim {dim}]·[/] "
        f"[{text}]exa[/] [dim {dim}]·[/] "
        f"[{text}]firecrawl[/] [dim {dim}]·[/] "
        f"[{text}]tavily[/] [dim {dim}]·[/] "
        f"[{text}]arxiv[/]\n"
    )


def _install_custom_banner() -> None:
    """Monkey-patch cli._build_compact_banner if cli module is importable."""
    try:
        import sys
        if "cli" not in sys.modules:
            import importlib
            importlib.import_module("cli")
        sys.modules["cli"]._build_compact_banner = _custom_compact_banner
        _debug("custom compact banner installed")
    except Exception as exc:
        _debug(f"banner install failed: {exc}")


_install_custom_banner()


def _run_script(script: Path, *args: str) -> None:
    """Run a shell script non-blocking, fire-and-forget."""
    cmd = [str(script)] + list(args)
    try:
        subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        _debug(f"SCRIPT ERROR ({script.name}): {exc}")


def _clean_for_speech(text: str) -> str:
    """Remove markdown formatting, code blocks, URLs for speech."""
    import re

    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[#*_~>|]", "", text)
    text = re.sub(r"/data/\S+", "", text)
    text = re.sub(r"~/?\S+\.\w{1,5}", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ---------------------------------------------------------------------------
# Hook implementations -- these get registered into the registry on first load
# and refreshed on hot-reload.
# ---------------------------------------------------------------------------

def _is_subagent(task_id: str, session_id: str) -> bool:
    """True if task_id looks like a real subagent ID (not a session ID).

    Session IDs are like '20260613_081925_6d9eee' (date_prefixed).
    Subagent task_ids are shorter UUIDs or hex strings without date prefix.
    """
    if not task_id:
        return False
    if task_id == session_id:
        return False
    import re
    if re.match(r'^\d{8}_', task_id):
        return False
    return True


def impl_on_session_start(session_id: str = "", **kwargs: Any) -> None:
    _debug(f"SESSION_START: {session_id}")
    _run_script(_SESSION_START_SCRIPT)


def impl_on_session_end(session_id: str = "", **kwargs: Any) -> None:
    _debug(f"SESSION_END: {session_id}")
    _run_script(_SESSION_END_SCRIPT)


def impl_on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    task_id: str = "",
    **kwargs: Any,
) -> None:
    """Incoming user message -- play notification chime."""
    if _is_subagent(task_id, session_id):
        return
    if user_message and "review the conversation" in user_message.lower():
        return
    if not user_message:
        return
    _debug(f"PRE_LLM: firing chime.sh")
    _run_script(_CHIME_SCRIPT)


def _start_council_drone() -> None:
    """Start looping ambient drone while council deliberates."""
    global _COUNCIL_DRONE_PID
    try:
        proc = subprocess.Popen(
            [str(_COUNCIL_DRONE_SCRIPT)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        with _COUNCIL_DRONE_LOCK:
            _COUNCIL_DRONE_PID = proc.pid
        _debug(f"COUNCIL_DRONE: started (pid={proc.pid})")
    except Exception as exc:
        _debug(f"COUNCIL_DRONE: start failed: {exc}")


def _stop_council_drone() -> None:
    """Kill the council drone loop."""
    global _COUNCIL_DRONE_PID
    with _COUNCIL_DRONE_LOCK:
        pid = _COUNCIL_DRONE_PID
        if pid and pid > 0:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
                _debug(f"COUNCIL_DRONE: stopped (pid={pid})")
            except (ProcessLookupError, PermissionError):
                pass
            _COUNCIL_DRONE_PID = 0


def impl_on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    task_id: str = "",
    session_id: str = "",
    **kwargs: Any,
) -> None:
    """Tool about to run -- play short 'starting' chime."""
    if _is_subagent(task_id, session_id):
        return
    if not tool_name:
        return
    # Special chime for delegate_task
    if tool_name == "delegate_task":
        _debug(f"PRE_TOOL: delegate_task -> delegate_chime.sh")
        _run_script(_DELEGATE_CHIME_SCRIPT)
    elif tool_name.startswith("council_") or tool_name.startswith("mcp_council_"):
        chime_name = tool_name.replace("mcp_council_", "") if tool_name.startswith("mcp_council_") else tool_name
        _debug(f"PRE_TOOL: {tool_name} -> council_chime.sh {chime_name}")
        _run_script(_COUNCIL_CHIME_SCRIPT, chime_name)
        # Start looping ambient drone while council deliberates
        _start_council_drone()
    else:
        _debug(f"PRE_TOOL: {tool_name}")
        _run_script(_TOOL_CHIME_SCRIPT)
def impl_on_post_tool_call(
    tool_name: str = "",
    args: Any = None,
    result: Any = None,
    task_id: str = "",
    session_id: str = "",
    **kwargs: Any,
) -> None:
    """Tool finished -- play 'done' chime."""
    if _is_subagent(task_id, session_id):
        return
    if not tool_name:
        return
    # Stop council drone if this was a council tool
    if tool_name.startswith("council_") or tool_name.startswith("mcp_council_"):
        _stop_council_drone()
    _debug(f"POST_TOOL: {tool_name}")
    _run_script(_TOOL_DONE_SCRIPT)




def impl_on_post_api_request(
    assistant_message: Any = None,
    assistant_content_chars: int = 0,
    assistant_tool_call_count: int = 0,
    finish_reason: str = "",
    task_id: str = "",
    session_id: str = "",
    user_message: str = "",
    **kwargs: Any,
) -> None:
    """Mid-turn speech: speak text-only LLM responses immediately."""
    if _is_subagent(task_id, session_id):
        _debug(f"POST_API: skipping subagent (task_id={task_id})")
        return
    if user_message and "review the conversation" in user_message.lower():
        _debug("POST_API: skipping background review")
        return

    if not assistant_message:
        return

    text = ""
    if isinstance(assistant_message, str):
        text = assistant_message
    elif hasattr(assistant_message, "content"):
        text = getattr(assistant_message, "content", "") or ""

    if not text or not text.strip():
        return

    clean = _clean_for_speech(text)
    if clean:
        _debug(f"POST_API: speak.sh ({len(clean)} chars)")
        _run_script(_SPEAK_SCRIPT, clean)
    else:
        _debug(f"POST_API: skipping (empty after clean)")


# ---------------------------------------------------------------------------
# Populate the registry with current implementations
# ---------------------------------------------------------------------------
def _populate_registry() -> None:
    global _HOOK_REGISTRY
    _HOOK_REGISTRY = {
        "on_session_start": impl_on_session_start,
        "on_session_end": impl_on_session_end,
        "pre_llm_call": impl_on_pre_llm_call,
        "pre_tool_call": impl_on_pre_tool_call,
        "post_tool_call": impl_on_post_tool_call,
        "post_api_request": impl_on_post_api_request,
    }


_populate_registry()


# ---------------------------------------------------------------------------
# Thin wrapper hooks -- these are what get registered with Hermes.
# They never change; they always call through the registry.
# ---------------------------------------------------------------------------
def _on_session_start(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("on_session_start")
    if fn:
        fn(**kwargs)


def _on_session_end(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("on_session_end")
    if fn:
        fn(**kwargs)


def _on_pre_llm_call(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("pre_llm_call")
    if fn:
        fn(**kwargs)


def _on_pre_tool_call(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("pre_tool_call")
    if fn:
        fn(**kwargs)


def _on_post_tool_call(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("post_tool_call")
    if fn:
        fn(**kwargs)


def _on_post_api_request(**kwargs: Any) -> None:
    fn = _HOOK_REGISTRY.get("post_api_request")
    if fn:
        fn(**kwargs)



# ---------------------------------------------------------------------------
# Hot-reload watcher
# ---------------------------------------------------------------------------
def _hot_reload_watcher() -> None:
    """Background daemon: polls __init__.py mtime, reloads on change."""
    global _SELF_MTIME
    try:
        _SELF_MTIME = _SELF_PATH.stat().st_mtime
    except Exception:
        return

    while True:
        time.sleep(2)
        try:
            current_mtime = _SELF_PATH.stat().st_mtime
            if current_mtime <= _SELF_MTIME:
                continue
        except Exception:
            continue

        with _RELOAD_LOCK:
            # Double-check after acquiring lock
            try:
                current_mtime = _SELF_PATH.stat().st_mtime
                if current_mtime <= _SELF_MTIME:
                    continue
            except Exception:
                continue

            _debug(f"HOT-RELOAD: __init__.py changed (mtime {_SELF_MTIME:.2f} -> {current_mtime:.2f})")
            try:
                import sys
                # Find the actual module key in sys.modules -- Hermes may load
                # it under a namespace like 'hermes_plugins.tts_speak'
                mod = sys.modules.get(__name__)
                if mod is None:
                    # Fallback: search by file path
                    _SELF_STR = str(_SELF_PATH)
                    for key, val in list(sys.modules.items()):
                        if val and getattr(val, "__file__", None) == _SELF_STR:
                            mod = val
                            _debug(f"HOT-RELOAD: found module as '{key}'")
                            break
                if mod is None:
                    raise RuntimeError(f"module '{__name__}' not found in sys.modules")
                importlib.reload(mod)
                _SELF_MTIME = current_mtime
                _debug("HOT-RELOAD: success")
            except Exception as exc:
                _debug(f"HOT-RELOAD: FAILED - {exc}")


def register(ctx) -> None:
    """Plugin entry point -- register all hooks + start hot-reload watcher."""
    _debug("REGISTER: wiring hooks")
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("post_api_request", _on_post_api_request)

    # Start hot-reload watcher daemon
    t = threading.Thread(target=_hot_reload_watcher, daemon=True, name="tts-speak-hot-reload")
    t.start()
    _debug(f"REGISTER: hot-reload watcher started (thread={t.ident})")
    _debug("REGISTER: done")
