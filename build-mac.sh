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

# A stable signing identity is what makes macOS privacy grants (Bluetooth,
# notifications) survive a rebuild: the designated requirement becomes
# "certificate leaf = H<hash>" instead of an ad-hoc cdhash that changes every
# build, so TCC stops re-prompting. Self-signed and local-only -- this is not
# distribution signing.
ENV_FILE=".env"
CODESIGN_SHA1_KEY="MACOS_CODESIGN_SHA1"
CODESIGN_COMMON_NAME="Super Productivity Local Dev"
# A dedicated, empty-password keychain rather than the login keychain. The
# signing key needs a partition list that permits codesign, and setting that on
# the login keychain would require the user's account password. This keychain
# holds nothing but a local self-signed dev certificate, so an empty password
# protects nothing of value and keeps the build non-interactive -- without it,
# codesign blocks on an invisible SecurityAgent dialog partway through signing.
CODESIGN_KEYCHAIN="$HOME/Library/Keychains/sp-codesign.keychain-db"

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

is_identity_in_keychain() {
  [[ -n "$1" ]] && [[ -f "$CODESIGN_KEYCHAIN" ]] &&
    security find-identity -p codesigning "$CODESIGN_KEYCHAIN" | grep -qi "$1"
}

# codesign resolves an identity through the keychain search list, so --keychain
# alone yields "no identity found". Appended, never replaced, so the user's
# login keychain keeps working.
ensure_keychain_in_search_list() {
  local existing=() entry line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    [[ -n "$line" ]] && existing+=("$line")
  done < <(security list-keychains -d user)

  for entry in "${existing[@]}"; do
    [[ "$entry" == "$CODESIGN_KEYCHAIN" ]] && return 0
  done
  security list-keychains -d user -s "${existing[@]}" "$CODESIGN_KEYCHAIN" >/dev/null
}

prepare_codesign_keychain() {
  ensure_keychain_in_search_list
  security unlock-keychain -p "" "$CODESIGN_KEYCHAIN"
}

read_env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

write_env_value() {
  local key="$1" value="$2"
  [[ -f "$ENV_FILE" ]] || : > "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE"; then
    local tmp
    tmp=$(mktemp)
    grep -v "^$key=" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

create_codesign_identity() {
  local workdir password sha1
  workdir=$(mktemp -d -t sp-codesign)
  password=$(openssl rand -hex 16)

  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$workdir/key.pem" -out "$workdir/cert.pem" \
    -subj "/CN=$CODESIGN_COMMON_NAME" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

  # -legacy is required: OpenSSL 3 defaults to an AES/PBKDF2-SHA256 MAC that
  # macOS Security.framework cannot verify, and the import fails with a
  # misleading "wrong password?".
  openssl pkcs12 -export -legacy -out "$workdir/cert.p12" \
    -inkey "$workdir/key.pem" -in "$workdir/cert.pem" \
    -passout "pass:$password" -name "$CODESIGN_COMMON_NAME" 2>/dev/null

  if [[ ! -f "$CODESIGN_KEYCHAIN" ]]; then
    security create-keychain -p "" "$CODESIGN_KEYCHAIN"
    # No argument means no idle timeout and no lock-on-sleep, so an unattended
    # build hours later still signs without a prompt.
    security set-keychain-settings "$CODESIGN_KEYCHAIN"
  fi
  prepare_codesign_keychain

  security import "$workdir/cert.p12" -k "$CODESIGN_KEYCHAIN" -P "$password" \
    -A -T /usr/bin/codesign >/dev/null
  # The ACL from -T is not enough on its own: without an explicit partition
  # list, codesign still triggers an authorization dialog on first key use.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" \
    "$CODESIGN_KEYCHAIN" >/dev/null 2>&1

  sha1=$(openssl x509 -in "$workdir/cert.pem" -noout -fingerprint -sha1 |
    sed 's/.*=//; s/://g')
  rm -rf "$workdir"

  is_identity_in_keychain "$sha1" || die "generated certificate did not land in the keychain"
  printf '%s' "$sha1"
}

resolve_codesign_identity() {
  local sha1
  sha1=$(read_env_value "$CODESIGN_SHA1_KEY")
  if is_identity_in_keychain "$sha1"; then
    printf '%s' "$sha1"
    return
  fi
  step "creating a local signing certificate" >&2
  sha1=$(create_codesign_identity)
  write_env_value "$CODESIGN_SHA1_KEY" "$sha1"
  printf '\033[2mstored %s in %s (gitignored); privacy grants now survive rebuilds\033[0m\n' \
    "$CODESIGN_SHA1_KEY" "$ENV_FILE" >&2
  printf '%s' "$sha1"
}

[[ "$(uname -m)" == arm64 ]] || die "this builds arm64 only; got $(uname -m)"

# node@22 is keg-only on purpose: the default node is 26, which this repo's
# .nvmrc does not pin. Prefix rather than change PATH globally.
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
command -v node >/dev/null || die "node@22 missing; brew install node@22"

# Resolved before the build, not after: a signing problem should surface in
# seconds rather than at the end of a multi-minute package step.
codesign_identity=$(resolve_codesign_identity)

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

step "bluetooth helper"
# CoreBluetooth is not reachable from Node, so the L2CAP transport lives in a
# small Swift helper the main process drives over stdio. It is signed together
# with the bundle, so it inherits the app's Bluetooth TCC grant.
swiftc -O electron/assets/sp-bluetooth-helper.swift -o electron/assets/sp-bluetooth-helper

step "packaging"
# electron-builder.yaml asks for notarization, a hardened runtime and a
# provisioning profile; all three need an Apple Developer account. Overriding
# identity to null makes it skip signing entirely, which is why the signing
# step below is not optional -- arm64 refuses to launch a repacked bundle
# whose signature was invalidated.
npx electron-builder --mac --arm64 --dir \
  --config.mac.notarize=false \
  --config.mac.identity=null \
  --config.mac.provisioningProfile=null \
  --config.mac.hardenedRuntime=false

[[ -d "$BUILT_APP" ]] || die "no bundle at $BUILT_APP"

step "signing"
# Signed by hash, not by name: the certificate is self-signed and therefore
# untrusted, so it never appears in `security find-identity -v` and a name
# lookup would miss it. codesign accepts it by hash and verifies fine.
# --keychain points at the dedicated keychain instead of mutating the user's
# global keychain search list.
prepare_codesign_keychain
codesign --force --deep --keychain "$CODESIGN_KEYCHAIN" \
  --sign "$codesign_identity" "$BUILT_APP"
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
