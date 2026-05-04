#compdef bench
# zsh completion for bench
_bench() {
  local -a cmds
  cmds=(
    'ask:Single-turn message to an agent'
    'chat:Per-agent interactive REPL'
    'feed:Compact fused snapshot'
    'agents:List configured agents'
    'sessions:List recent sessions for an agent'
    'tasks:List tracked background tasks'
    'status:Gateway / channel / agent health'
    'tail:Live-tail the gateway log stream'
    'commitments:Inferred follow-up commitments'
    'setup:Run readiness checks'
    'version:Print version'
    'help:Show help'
  )
  if (( CURRENT == 2 )); then
    _describe 'bench command' cmds
    return
  fi
  case "${words[2]}" in
    ask|chat|sessions)
      if (( CURRENT == 3 )); then
        local -a agents
        agents=( ${(f)"$(bench agents --json 2>/dev/null | sed -n 's/.*"id":[[:space:]]*"\([^"]*\)".*/\1/p')"} aurelius cole piper sage ember bailey kestrel-coder )
        _wanted agents expl 'agent' compadd -a agents
      fi
      ;;
    tasks)
      _arguments \
        '--status[Filter by status]:status:(queued running succeeded failed timed_out cancelled lost)' \
        '--runtime[Filter by kind]:runtime:(subagent acp cron cli)' \
        '--limit[Max rows]:n:' \
        '--json[JSON output]'
      ;;
    commitments)
      _arguments \
        '--status[Filter by status]:status:(pending sent dismissed snoozed expired)' \
        '--all[Include all statuses]' \
        '--agent[Filter by agent]:agent:' \
        '--json[JSON output]'
      ;;
    *)
      _arguments '--help[Show help]' '--json[JSON output]'
      ;;
  esac
}
_bench "$@"
