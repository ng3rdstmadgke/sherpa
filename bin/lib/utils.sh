#!/bin/bash

function error {
  local msg="$1"
  printf "\033[31m[error]\033[0m %s\n" "$msg" >&2
  exit 1
}

function info {
  local msg="$1"
  printf "\033[32m[info]\033[0m %s\n" "$msg" >&2
}