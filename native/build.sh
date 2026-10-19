#!/bin/sh
# Builds the trusted-input helper to native/build/zen-mcp-input (gitignored).
#
# Accessibility is granted to that binary. Signed ad-hoc, every rebuild changes its code hash
# and macOS drops the grant; signed with a real identity, the grant follows the identifier and
# team and survives rebuilds. So it signs with ZEN_MCP_SIGN_IDENTITY if set, else the first
# "Developer ID Application" identity in the keychain, else ad-hoc.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/build"
swiftc -O -o "$here/build/zen-mcp-input" "$here/zen-mcp-input/main.swift"
identity=${ZEN_MCP_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)}
codesign --force -s "${identity:--}" --identifier io.cxrobx.zen-mcp-input "$here/build/zen-mcp-input"
echo "built $here/build/zen-mcp-input (signed: ${identity:-ad-hoc})"
