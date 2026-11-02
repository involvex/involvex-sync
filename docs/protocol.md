# Wire protocol

Version: `1`

## Cleartext body (inside AEAD)

```json
{
  "v": 1,
  "id": "hex-random",
  "from": "deviceId",
  "to": "optional-peer-id",
  "ts": 1710000000000,
  "payload": { "type": "share_url", "url": "https://example.com" }
}
```

Payload types: `share_url`, `clipboard_update`, `ping`, `pong`, `pair_ack`,
`termux_open_url`, `termux_clipboard_set`, `file_transfer`, `file_offer`,
`file_chunk`, `file_done`, `file_abort`, `notification_mirror`,
`keyboard_text`, `keyboard_key`, `keyboard_status`, `find_phone`.

Chunked files: soft cap 100 MiB, ~64 KiB decoded chunks, `sha256` on
`file_done`. Legacy `file_transfer` remains for ≤2 MiB.

## Signed envelope

```json
{
  "v": 1,
  "from": "deviceId",
  "nonce": "hex-24-bytes",
  "ciphertext": "hex",
  "signature": "hex-ed25519"
}
```

Signature input UTF-8: `v{version}|{from}|{nonce}|{ciphertext}`.

## URL allowlist

Only `http:` and `https:` without embedded credentials. `file:`, `javascript:`,
`intent:`, `data:` are rejected.
