#!/usr/bin/env bash
# Build the Android APK from source and install it on the attached device.
# Usage: ./build-android.sh [--launch]
# Set ANDROID_SERIAL to pick a device when more than one is attached.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PKG="com.superproductivity.superproductivity"
APK="android/app/build/outputs/apk/fdroid/debug/app-fdroid-debug.apk"
JDK="/opt/homebrew/opt/openjdk@21"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
MIN_SDK=24

# build:packages re-marks a dev dependency in the lockfile as a side effect of
# the frontend build. Not an intentional edit, and leaving it dirty breaks the
# pre-commit hook, so it is put back afterwards.
GENERATED="package-lock.json"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

LAUNCH=0
KEEP_GENERATED=0
while (( $# )); do
  case "$1" in
    --launch) LAUNCH=1 ;;
    --keep-generated) KEEP_GENERATED=1 ;;
    *) die "usage: $0 [--launch] [--keep-generated]" ;;
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

export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
command -v node >/dev/null || die "node@22 missing; brew install node@22"
command -v adb >/dev/null || die "adb missing; brew install --cask android-platform-tools"
[[ -d "$JDK" ]] || die "openjdk@21 missing at $JDK; the android build compiles at JavaVersion.VERSION_21"
[[ -d "$SDK" ]] || die "no Android SDK at $SDK; run Android Studio's first-run wizard"

# Resolve the target before building: a two-minute build that ends in "no
# devices/emulators found" is two minutes wasted.
step "finding device"
adb start-server >/dev/null 2>&1 || true
attached=$(adb devices | awk 'NR>1 && NF>=2 {print $1"\t"$2}')
ready=$(printf '%s\n' "$attached" | awk -F'\t' '$2=="device" {print $1}' | grep . || true)
notready=$(printf '%s\n' "$attached" | awk -F'\t' '$2!="device" && NF {print "  "$1" ("$2")"}' | grep . || true)

with_notready() {
  if [[ -n "$notready" ]]; then printf '%s\nnot ready:\n%s\n' "$1" "$notready"; else printf '%s\n' "$1"; fi
}

is_wireless_transport() { [[ "$1" == *_adb-tls-connect._tcp ]]; }

# One phone attached over USB *and* adb-over-TLS shows up twice in
# `adb devices` under two transport serials, which otherwise looks like two
# devices and forces ANDROID_SERIAL for no reason. Group transports by the
# hardware serial each one reports, and keep the USB transport: it is faster
# and does not drop partway through an install.
unique_device_transports() {
  local serial hardware rank rows=""
  while IFS= read -r serial; do
    [[ -n "$serial" ]] || continue
    hardware=$(adb -s "$serial" shell getprop ro.serialno 2>/dev/null | tr -d '\r')
    [[ -n "$hardware" ]] || hardware="$serial"
    if is_wireless_transport "$serial"; then rank=1; else rank=0; fi
    rows+="$hardware	$rank	$serial"$'\n'
  done
  printf '%s' "$rows" | sort -t'	' -k1,1 -k2,2n | awk -F'	' 'NF && !seen[$1]++ {print $3}'
}

if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  if ! printf '%s\n' "$ready" | grep -qx "$ANDROID_SERIAL"; then
    die "$(with_notready "ANDROID_SERIAL=$ANDROID_SERIAL is not attached and ready")"
  fi
  serial="$ANDROID_SERIAL"
else
  distinct=$(printf '%s\n' "$ready" | unique_device_transports)
  count=$(printf '%s\n' "$distinct" | grep -c . || true)
  if (( count == 0 )); then
    die "$(with_notready "no device ready; attach one over USB, unlock it and accept the debugging prompt")"
  elif (( count > 1 )); then
    die "$count devices attached; set ANDROID_SERIAL to one of:"$'\n'"$(printf '%s\n' "$distinct" | sed 's/^/  /')"
  fi
  serial="$distinct"
fi

api=$(adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')
(( api >= MIN_SDK )) || die "device is API $api, below minSdk $MIN_SDK"
model=$(adb -s "$serial" shell getprop ro.product.model | tr -d '\r')
printf '%s (%s, API %s)\n' "$serial" "$model" "$api"

if [[ ! -d node_modules ]]; then step "installing dependencies"; npm ci; fi

if (( ! KEEP_GENERATED )); then
  snapshot=$(mktemp -d -t sp-build)
  trap restore_generated EXIT
  while IFS= read -r f; do
    if [[ -f "$f" ]]; then cp "$f" "$snapshot/$(basename "$f")"; fi
  done <<< "$GENERATED"
fi

step "frontend (production web)"
npm run buildFrontend:prodWeb

step "syncing capacitor"
npx cap sync android

step "gradle"
# assembleFdroidDebug, not assembleDebug: the latter also builds the unused
# play flavor. There is no android/local.properties, so the env vars below are
# what tell Gradle where the SDK is. AGP auto-downloads any missing platform.
( cd android && JAVA_HOME="$JDK" ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" ./gradlew assembleFdroidDebug )

[[ -f "$APK" ]] || die "no apk at $APK"

step "installing"
if ! out=$(adb -s "$serial" install -r "$APK" 2>&1); then
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q INSTALL_FAILED_UPDATE_INCOMPATIBLE; then
    die "$PKG is already installed with a different signature (a Play Store or F-Droid build). Uninstalling wipes that app's data, so do it deliberately: adb -s $serial uninstall $PKG"
  fi
  die "install failed"
fi

version=$(adb -s "$serial" shell dumpsys package "$PKG" | awk -F= '/versionName=/ {print $2; exit}' | tr -d '\r')
printf '\n\033[32minstalled\033[0m %s %s (%s) on %s\n' "$PKG" "$version" \
  "$(du -h "$APK" | cut -f1 | tr -d ' ')" "$model"

if (( LAUNCH )); then
  step "launching"
  adb -s "$serial" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
fi
