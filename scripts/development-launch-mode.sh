#!/usr/bin/env bash

# Explicit CLI modes, independent of shell/global environment defaults.
corptie_development_launch_mode() {
  local mode="$1"
  shift
  for argument in "$@"; do
    case "${argument}" in
      --background) mode=background ;;
      --foreground) mode=foreground ;;
      *) echo "Unknown launch option: ${argument}. Use --background or --foreground." >&2; return 2 ;;
    esac
  done
  printf '%s\n' "${mode}"
}
