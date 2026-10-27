#!/bin/bash
# Unfold an iPhone Duo simulator on a headless Mac (GitHub runner).
#
# A simctl-booted Duo cannot be unfolded: only Device Hub initialises the inner
# panel's framebuffer, and nothing in simctl/devicectl sets the pose (docs/DUO.md).
# So this opens Device Hub on the device and drives its menus through System
# Events. It needs Accessibility for osascript, which the GitHub macOS images
# grant to their shell tools. Every menu item is printed first so a renamed
# command shows up in the log instead of failing silently.
#
# usage: tools/unfold.sh <udid>
set -u
UDID="$1"
DEV=$(xcode-select -p)
OUT="${RUNNER_TEMP:-/tmp}"

HUB=$(find "$DEV/Applications" "$DEV/../Applications" -maxdepth 1 -name '*.app' 2>/dev/null | grep -i 'device hub' | head -1)
[ -n "$HUB" ] || HUB=$(find "$DEV/Applications" -maxdepth 1 -name 'Simulator.app' | head -1)
[ -n "$HUB" ] || { echo "no Device Hub or Simulator app under $DEV"; exit 1; }
PROC=$(basename "$HUB" .app)
echo "opening $HUB on $UDID"
open -a "$HUB" --args -CurrentDeviceUDID "$UDID"
sleep 25
screencapture -x "$OUT/unfold-0-opened.png" 2>/dev/null

echo "--- menus of $PROC"
osascript - "$PROC" <<'APPLESCRIPT'
on run argv
  set procName to item 1 of argv
  set out to ""
  tell application "System Events"
    tell process procName
      set frontmost to true
      repeat with m in menu bar items of menu bar 1
        try
          repeat with mi in menu items of menu 1 of m
            set out to out & (name of m) & " > " & (name of mi as text) & linefeed
            try
              repeat with si in menu items of menu 1 of mi
                set out to out & (name of m) & " > " & (name of mi as text) & " > " & (name of si as text) & linefeed
              end repeat
            end try
          end repeat
        end try
      end repeat
    end tell
  end tell
  return out
end run
APPLESCRIPT

echo "--- clicking the first menu item that unfolds"
osascript - "$PROC" <<'APPLESCRIPT'
on run argv
  set procName to item 1 of argv
  set wanted to {"Unfold", "Open Device", "Flat", "Fully Open"}
  tell application "System Events"
    tell process procName
      set frontmost to true
      repeat with w in wanted
        repeat with m in menu bar items of menu bar 1
          try
            repeat with mi in menu items of menu 1 of m
              if (name of mi as text) contains w then
                click mi
                return "clicked " & (name of m) & " > " & (name of mi as text)
              end if
              try
                repeat with si in menu items of menu 1 of mi
                  if (name of si as text) contains w then
                    click si
                    return "clicked " & (name of m) & " > " & (name of mi as text) & " > " & (name of si as text)
                  end if
                end repeat
              end try
            end repeat
          end try
        end repeat
      end repeat
    end tell
  end tell
  return "no unfold item found"
end run
APPLESCRIPT
sleep 8
screencapture -x "$OUT/unfold-1-after.png" 2>/dev/null
xcrun simctl io "$UDID" enumerate | grep -E 'Display class|Port|UUID' || true
