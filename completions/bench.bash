# bash completion for bench
_bench() {
  local cur prev cmds
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  cmds="ask chat feed agents sessions tasks status tail commitments setup version help"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    ask|chat|sessions)
      if [ "$COMP_CWORD" -eq 2 ]; then
        local agents
        agents=$(bench agents --json 2>/dev/null | sed -n 's/.*"id":[[:space:]]*"\([^"]*\)".*/\1/p')
        agents="$agents aurelius cole piper sage ember bailey kestrel-coder"
        COMPREPLY=( $(compgen -W "${agents}" -- "${cur}") )
        return 0
      fi
      ;;
    tasks)
      case "$prev" in
        --status) COMPREPLY=( $(compgen -W "queued running succeeded failed timed_out cancelled lost" -- "${cur}") ); return 0 ;;
        --runtime) COMPREPLY=( $(compgen -W "subagent acp cron cli" -- "${cur}") ); return 0 ;;
      esac
      ;;
    commitments)
      case "$prev" in
        --status) COMPREPLY=( $(compgen -W "pending sent dismissed snoozed expired" -- "${cur}") ); return 0 ;;
      esac
      ;;
  esac
  COMPREPLY=( $(compgen -W "--help --json" -- "${cur}") )
}
complete -F _bench bench
