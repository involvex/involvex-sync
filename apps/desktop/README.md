# involvex Sync — desktop (Tauri 2)

Windows tray app for the LAN/relay link: clipboard, URLs, files, remote
commands, and the Google Drive sinks.

## Run / build

```bash
bun install                 # from the repo root
bun run desktop:dev         # Vite + Tauri dev (debug build, has a console)
bun run desktop:build       # release bundle

cd apps/desktop
bun run check               # bun check (typecheck)
bun test                    # service-level unit tests (adbDevices, session routing)
```

Requires Rust, WebView2, and `gws` on `PATH` for Drive features.

## Google Drive

Folder sync (PC → Drive) and the read-only Drive browser both shell out to
[`gws`](https://github.com/googleworkspace/cli) (`gws 0.22.x` tested), using the
credentials stored by `gws auth login -s drive`:

- Upload: `gws drive +upload <path> --name <name> [--parent <folderId>]`
- Probe: `gws drive about get --params '{"fields":"user,storageQuota"}'`
- Browse (Files tab, read-only, My Drive, 50 per page):

  ```bash
  gws drive files list --params '{"pageSize":50,"fields":"files(id,name,mimeType,size,modifiedTime),nextPageToken","orderBy":"modifiedTime desc","q":"'"'"'root'"'"' in parents and trashed = false"}'
  ```

  The root page uses `'root' in parents` on purpose: bare `trashed = false`
  means "every file at every depth" (flattened), which is not a folder listing.

The browser drills into folders, opens files in the Drive web UI through the
same `http(s)` URL allowlist as shared links, and can write the current folder
id into settings ("Use as sync folder"). Nothing is uploaded or deleted from the
browser.

`gws` prints `Using keyring backend: keyring` on stderr for every call; that
line is filtered out of error hints, so treat it as noise when debugging.

## Devices

Pairing is full-mesh and stored as a list (`src-tauri/src/keys.rs`:
`load_peers`/`save_peer`/`remove_peer`/`clear_peers`). The deprecated
single-peer keyring entry is folded in on first read, so upgrading keeps the
existing pairing.

`src-tauri/src/ws.rs` keeps one task per socket in a map keyed by conn id:

- `ws_send_to` → one specific socket (the session maps `deviceId → connId` from
  inbound frames, so the _selected_ device gets the frame, not the newest).
- `ws_send` → the active (or only) socket; fallback when no mapping is known.
- `ws_conns` lists live sockets, `ws_close` drops one.
- Ping every 15 s, peers reaped after 75 s of silence (a phone that drops off
  Wi-Fi never closes the socket, so this is the only cleanup path).
- `ws-message` events carry `{ connId, message }` — the conn id is how pair
  accept/reject and per-device routing work.

Anything outbound (`services/session.ts` `sendRaw`) tries the LAN socket first
and then the relay, so no payload type is LAN-only.

## Process spawning

Release builds are `windows_subsystem = "windows"` (no console). Every child
process (`gws`, `adb`, `pwsh`/`powershell`, `netsh`) is started with
`CREATE_NO_WINDOW` through `hide_child_console()` in
`src-tauri/src/shell.rs` (`netsh` lives in `src-tauri/src/firewall.rs` and uses
the same helper), so no console window flashes on screen. Do not add a
`Command::new(..)` that skips `hide_child_console()`, and never route user input
through `cmd /c` — arguments are passed as argv only (argv count/length caps
enforced in `run_gws`).

Debug builds keep a console (the attribute is `not(debug_assertions)`), so a
missing `CREATE_NO_WINDOW` is only visible in a release/installed build.
