#!/usr/bin/env bun
/**
 * isync — quick CLI for involvex Sync.
 *
 * Talks to the running desktop app over loopback HTTP (127.0.0.1:17392).
 * Clipboard get/set also work against the OS clipboard without the app.
 */

import { parseAllowedUrl } from "@involvex/protocol";

const CONTROL = "http://127.0.0.1:17392";

type Status = {
  ok: boolean;
  control?: boolean;
  peerConnected?: boolean;
  peerAddr?: string | null;
  listening?: boolean;
  lanPort?: number;
  windowVisible?: boolean;
  activePeerId?: string | null;
  peerCount?: number;
  error?: string;
};

type ControlPeer = {
  deviceId: string;
  name: string;
  connected: boolean;
};

type ControlNote = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
};

function usage(exitCode = 1): never {
  console.log(`isync — involvex Sync CLI

Usage:
  isync status                 Desktop + peer status
  isync show                   Bring the desktop window forward
  isync peers                  List paired peers
  isync peer use <id>          Select active peer
  isync notes list             List synced notes
  isync notes add <title> …    Add a note (body from rest args or stdin)
  isync file <path>            Send a file to the active peer
  isync remote termux <cmd>    Run a Termux command on the phone
  isync remote pwsh <cmd>      Run PowerShell locally via the desktop app
  isync clipboard get          Print OS clipboard
  isync clipboard set [text]   Set OS clipboard (stdin if no text)
  isync clipboard push         Push OS clipboard to the phone
  isync clipboard history      List shared text clipboard history
  isync clipboard resend <id>  Resend one history row to the phone
  isync share <url>            Send a link to the phone
  isync find                   Ring the phone
  isync keyboard type [text]   Type text on the phone (IME or a11y)
  isync keyboard key <id>      Send a key (enter, backspace, tab, …)
  isync screenshot             ADB screencap → PC clipboard
  isync mirror start|stop      Start/stop local scrcpy mirror
  isync escrcpy open           Open Escrcpy GUI for the selected device

Requires the desktop app running for share / push / find / keyboard / screenshot /
mirror / escrcpy / peers / notes / file / remote / status.
`);
  process.exit(exitCode);
}

async function control(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${CONTROL}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "text/plain" } : undefined,
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function requireDesktop(): Promise<Status> {
  try {
    const { status, text } = await control("GET", "/v1/status");
    if (status !== 200) {
      throw new Error(`HTTP ${status}: ${text}`);
    }
    return JSON.parse(text) as Status;
  } catch (e) {
    console.error(
      `desktop app not reachable on ${CONTROL}\nstart involvex Sync first (${String(e)})`,
    );
    process.exit(2);
  }
}

async function writeProcStdin(
  proc: ReturnType<typeof Bun.spawn>,
  text: string,
): Promise<void> {
  // Bun.FileSink typing is loose across versions; write bytes then close.
  const stdin = proc.stdin as unknown as {
    write: (data: string) => number | Promise<number>;
    end: (error?: Error) => void | Promise<void>;
  };
  if (!stdin || typeof stdin.write !== "function") {
    throw new Error("stdin not available");
  }
  await stdin.write(text);
  await stdin.end();
}

async function osClipboardGet(): Promise<string> {
  if (process.platform === "win32") {
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.replace(/\r\n$/, "").replace(/\n$/, "");
  }
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }
  const proc = Bun.spawn(["xclip", "-selection", "clipboard", "-o"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function osClipboardSet(text: string): Promise<void> {
  if (process.platform === "win32") {
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    await writeProcStdin(proc, text);
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err || `Set-Clipboard exit ${code}`);
    }
    return;
  }
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore" });
    await writeProcStdin(proc, text);
    await proc.exited;
    return;
  }
  const proc = Bun.spawn(["xclip", "-selection", "clipboard"], {
    stdin: "pipe",
    stdout: "ignore",
  });
  await writeProcStdin(proc, text);
  await proc.exited;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(Buffer.from(chunk as string));
    chunks.push(bytes);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(out).replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage(cmd ? 0 : 1);
  }

  if (cmd === "status") {
    const st = await requireDesktop();
    const peer = st.peerConnected
      ? `peer connected${st.peerAddr ? ` (${st.peerAddr})` : ""}`
      : "no peer";
    const peerInfo =
      st.peerCount != null
        ? ` · ${st.peerCount} paired${st.activePeerId ? ` · active ${st.activePeerId}` : ""}`
        : "";
    console.log(
      `desktop ok · lan :${st.lanPort ?? "?"} · ${peer}${peerInfo} · window ${st.windowVisible ? "visible" : "hidden"}`,
    );
    return;
  }

  if (cmd === "show") {
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/show");
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log("window shown");
    return;
  }

  if (cmd === "find") {
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/find");
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log("find phone sent");
    return;
  }

  if (cmd === "share") {
    const urlArg = sub ?? (await readStdin());
    const url = parseAllowedUrl(urlArg);
    if (!url) {
      console.error("need an http(s) url");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/share", url);
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log(`shared ${url}`);
    return;
  }

  if (cmd === "keyboard") {
    await requireDesktop();
    if (sub === "type") {
      const text = rest.join(" ") || (await readStdin());
      if (!text) {
        console.error("nothing to type — pass text or pipe stdin");
        process.exit(1);
      }
      const { status, text: body } = await control(
        "POST",
        "/v1/keyboard",
        JSON.stringify({ type: "text", text }),
      );
      if (status >= 400) {
        console.error(body);
        process.exit(1);
      }
      console.log(`typed ${text.length} chars → phone`);
      return;
    }
    if (sub === "key") {
      const key = rest[0];
      const allowed = new Set([
        "enter",
        "backspace",
        "tab",
        "escape",
        "arrow_left",
        "arrow_right",
        "arrow_up",
        "arrow_down",
        "delete",
      ]);
      if (!key || !allowed.has(key)) {
        console.error(
          "need a key id: enter | backspace | tab | escape | arrow_* | delete",
        );
        process.exit(1);
      }
      const { status, text: body } = await control(
        "POST",
        "/v1/keyboard",
        JSON.stringify({ type: "key", key }),
      );
      if (status >= 400) {
        console.error(body);
        process.exit(1);
      }
      console.log(`key ${key} → phone`);
      return;
    }
    usage();
  }

  if (cmd === "screenshot") {
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/screenshot");
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log("screenshot requested");
    return;
  }

  if (cmd === "mirror") {
    if (sub !== "start" && sub !== "stop") {
      console.error("usage: isync mirror start|stop");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/mirror", sub);
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log(`mirror ${sub} requested`);
    return;
  }

  if (cmd === "escrcpy") {
    if (sub && sub !== "open") {
      console.error("usage: isync escrcpy open");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/escrcpy");
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log("escrcpy open requested");
    return;
  }

  if (cmd === "peers") {
    await requireDesktop();
    const { status, text } = await control("GET", "/v1/peers");
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    const peers = JSON.parse(text) as ControlPeer[];
    if (peers.length === 0) {
      console.log("no peers paired");
      return;
    }
    for (const p of peers) {
      console.log(`${p.connected ? "●" : "○"} ${p.name}\t${p.deviceId}`);
    }
    return;
  }

  if (cmd === "peer") {
    if (sub !== "use" || !rest[0]) {
      console.error("usage: isync peer use <deviceId>");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/peer", rest[0]);
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log(`active peer → ${rest[0]}`);
    return;
  }

  if (cmd === "notes") {
    await requireDesktop();
    if (sub === "list") {
      const { status, text } = await control("GET", "/v1/notes");
      if (status >= 400) {
        console.error(text);
        process.exit(1);
      }
      const notes = JSON.parse(text) as ControlNote[];
      if (notes.length === 0) {
        console.log("no notes");
        return;
      }
      for (const n of notes) {
        const preview = (n.body || "").replace(/\s+/g, " ").slice(0, 60);
        console.log(`${n.id}\t${n.title}${preview ? ` — ${preview}` : ""}`);
      }
      return;
    }
    if (sub === "add") {
      const title = rest[0];
      if (!title) {
        console.error("usage: isync notes add <title> [body…]");
        process.exit(1);
      }
      const bodyFromArgs = rest.slice(1).join(" ");
      const body = bodyFromArgs || (await readStdin());
      const { status, text } = await control(
        "POST",
        "/v1/notes",
        JSON.stringify({ title, body }),
      );
      if (status >= 400) {
        console.error(text);
        process.exit(1);
      }
      console.log(`note added: ${title}`);
      return;
    }
    usage();
  }

  if (cmd === "file") {
    const path = sub ?? (await readStdin());
    if (!path.trim()) {
      console.error("usage: isync file <absolute-path>");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control("POST", "/v1/file", path.trim());
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log(`file send requested: ${path.trim()}`);
    return;
  }

  if (cmd === "remote") {
    const shell = sub;
    if (shell !== "termux" && shell !== "pwsh") {
      console.error("usage: isync remote <termux|pwsh> <command…>");
      process.exit(1);
    }
    const command = rest.join(" ") || (await readStdin());
    if (!command.trim()) {
      console.error("nothing to run — pass a command or pipe stdin");
      process.exit(1);
    }
    await requireDesktop();
    const { status, text } = await control(
      "POST",
      "/v1/remote",
      JSON.stringify({ shell, command: command.trim() }),
    );
    if (status >= 400) {
      console.error(text);
      process.exit(1);
    }
    console.log(`remote ${shell} requested`);
    return;
  }

  if (cmd === "clipboard") {
    if (sub === "get") {
      const text = await osClipboardGet();
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    if (sub === "set") {
      const text = rest.join(" ") || (await readStdin());
      if (!text) {
        console.error("nothing to set — pass text or pipe stdin");
        process.exit(1);
      }
      await osClipboardSet(text);
      console.log(`clipboard set (${text.length} chars)`);
      return;
    }
    if (sub === "push") {
      const text = await osClipboardGet();
      if (!text) {
        console.error("clipboard empty");
        process.exit(1);
      }
      await requireDesktop();
      const { status, text: body } = await control(
        "POST",
        "/v1/clipboard",
        text,
      );
      if (status >= 400) {
        console.error(body);
        process.exit(1);
      }
      const asUrl = parseAllowedUrl(text);
      console.log(
        asUrl
          ? `pushed url ${asUrl}`
          : `pushed clipboard (${text.length} chars)`,
      );
      return;
    }
    if (sub === "history") {
      await requireDesktop();
      const { status, text: body } = await control(
        "GET",
        "/v1/clipboard/history",
      );
      if (status >= 400) {
        console.error(body);
        process.exit(1);
      }
      const rows = JSON.parse(body) as Array<{
        id: string;
        text: string;
        updatedAt: number;
      }>;
      if (rows.length === 0) {
        console.log("(empty)");
        return;
      }
      for (const row of rows) {
        const preview =
          row.text.length > 80 ? `${row.text.slice(0, 80)}…` : row.text;
        console.log(`${row.id}\t${preview.replace(/\s+/g, " ")}`);
      }
      return;
    }
    if (sub === "resend") {
      const id = rest[0]?.trim();
      if (!id) {
        console.error("need a history id — run isync clipboard history");
        process.exit(1);
      }
      await requireDesktop();
      const { status, text: body } = await control(
        "POST",
        "/v1/clipboard/history/resend",
        id,
      );
      if (status >= 400) {
        console.error(body);
        process.exit(1);
      }
      console.log(`resent ${id}`);
      return;
    }
    usage();
  }

  usage();
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
