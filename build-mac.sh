#!/usr/bin/env bash
# Build the macOS app from source and replace /Applications/Super Productivity.app.
# Usage: ./build-mac.sh [--launch | --no-launch] [--keep-generated]
# By default the app is relaunched only if it was running when the script started.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

APP_NAME="Super Productivity"
BUNDLE_ID="com.super-productivity.app"
BUILT_APP=".tmp/app-builds/mac-arm64/${APP_NAME}.app"
INSTALLED_APP="/Applications/${APP_NAME}.app"
RUNNING_PATTERN="/Applications/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"

# Both are rewritten as a side effect of building: beforePack regenerates the
# icns, and build:packages re-marks a dev dependency in the lockfile. Neither is
# an intentional edit, and leaving them dirty breaks the pre-commit hook, so
# they are put back afterwards.
GENERATED="build/icon.icns
package-lock.json"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
is_running() { pgrep -f "$RUNNING_PATTERN" >/dev/null 2>&1; }

LAUNCH=auto
KEEP_GENERATED=0
while (( $# )); do
  case "$1" in
    --launch) LAUNCH=1 ;;
    --no-launch) LAUNCH=0 ;;
    --keep-generated) KEEP_GENERATED=1 ;;
    *) die "usage: $0 [--launch | --no-launch] [--keep-generated]" ;;
  esac
  shift
done

snapshot=""
restore_generated() {
  local rc=$? f restored=""
  if [[ -n "$snapshot" ]]; then
    while IFS= read -r f; do
      if [[ -f "$snapshot/$(basename "$f")" ]] && ! cmp -s "$snapshot/$(basename "$f")" "$f"; then
        cp "$snapshot/$(basename "$f")" "$f"
        restored="$restored $f"
      fi
    done <<< "$GENERATED"
    rm -rf "$snapshot"
    snapshot=""
    if [[ -n "$restored" ]]; then
      printf '\033[2mreverted build-generated changes to:%s (--keep-generated to keep them)\033[0m\n' "$restored"
    fi
  fi
  return $rc
}

[[ "$(uname -m)" == arm64 ]] || die "this builds arm64 only; got $(uname -m)"

# node@22 is keg-only on purpose: the default node is 26, which this repo's
# .nvmrc does not pin. Prefix rather than change PATH globally.
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
command -v node >/dev/null || die "node@22 missing; brew install node@22"

WAS_RUNNING=0
if is_running; then WAS_RUNNING=1; fi
if [[ "$LAUNCH" == auto ]]; then LAUNCH=$WAS_RUNNING; fi

if [[ ! -d node_modules ]]; then step "installing dependencies"; npm ci; fi

if (( ! KEEP_GENERATED )); then
  snapshot=$(mktemp -d -t sp-build)
  trap restore_generated EXIT
  while IFS= read -r f; do
    if [[ -f "$f" ]]; then cp "$f" "$snapshot/$(basename "$f")"; fi
  done <<< "$GENERATED"
fi

step "frontend (production, es6)"
npm run buildFrontend:prod:es6

step "electron main process"
npm run electron:build

step "packaging"
# electron-builder.yaml asks for notarization, a hardened runtime and a
# provisioning profile; all three need an Apple Developer account. Overriding
# identity to null makes it skip signing entirely, which is why the ad-hoc
# signature below is not optional -- arm64 refuses to launch a repacked bundle
# whose signature was invalidated.
npx electron-builder --mac --arm64 --dir \
  --config.mac.notarize=false \
  --config.mac.identity=null \
  --config.mac.provisioningProfile=null \
  --config.mac.hardenedRuntime=false

[[ -d "$BUILT_APP" ]] || die "no bundle at $BUILT_APP"

step "ad-hoc signing"
codesign --force --deep --sign - "$BUILT_APP"
identifier=$(codesign -dv "$BUILT_APP" 2>&1 | sed -n 's/^Identifier=//p')
[[ "$identifier" == "$BUNDLE_ID" ]] ||
  die "signed as '$identifier', expected '$BUNDLE_ID' -- an Electron identifier means the Info.plist stayed unbound, which breaks notifications and keychain identity"

step "installing to /Applications"
if (( WAS_RUNNING )); then
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 20); do is_running || break; sleep 0.5; done
  if is_running; then
    pkill -f "$RUNNING_PATTERN" || true
    for _ in $(seq 10); do is_running || break; sleep 0.5; done
  fi
  ! is_running || die "could not quit the running app; quit it and rerun"
fi

if [[ -d "$INSTALLED_APP" ]]; then
  [[ "$INSTALLED_APP" == /Applications/*.app ]] || die "refusing to remove $INSTALLED_APP"
  rm -rf "$INSTALLED_APP"
fi
# ditto, not cp -R: cp drops the extended attributes the signature covers.
ditto "$BUILT_APP" "$INSTALLED_APP"
codesign --verify --strict "$INSTALLED_APP" || die "installed bundle fails signature verification"

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED_APP/Contents/Info.plist")
printf '\n\033[32minstalled\033[0m %s %s\n' "$APP_NAME" "$version"

if (( LAUNCH )); then
  step "launching"
  open -a "$INSTALLED_APP"
fi
