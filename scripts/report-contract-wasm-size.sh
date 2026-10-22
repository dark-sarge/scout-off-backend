#!/usr/bin/env bash
set -euo pipefail

wasm_dir="contracts/target/wasm32-unknown-unknown/release"
mapfile -t wasm_files < <(find "$wasm_dir" -maxdepth 1 -type f -name '*.wasm' -print | sort)

if ((${#wasm_files[@]} == 0)); then
  echo "No optimized WASM contracts found in $wasm_dir" >&2
  exit 1
fi

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "### Optimized Soroban WASM sizes"
  echo
  echo "| Artifact | Size (bytes) |"
  echo "|---|---:|"
  for wasm_file in "${wasm_files[@]}"; do
    printf '| `%s` | %s |\n' "$(basename "$wasm_file")" "$(wc -c < "$wasm_file" | tr -d ' ')"
  done
} | tee -a "$summary"
