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
  error?: string;
};

function usage(exitCode = 1): never {
  console.log(`isync — involvex Sync CLI

Usage:
  isync status                 Desktop + peer status
  isync show                   Bring the desktop window forward
  isync clipboard get          Print OS clipboard
  isync clipboard set [text]   Set OS clipboard (stdin if no text)
  isync clipboard push         Push OS clipboard to the phone
  isync share <url>            Send a link to the phone
  isync find                   Ring the phone

Requires the desktop app running for share / push / find / status.
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
    console.log(
      `desktop ok · lan :${st.lanPort ?? "?"} · ${peer} · window ${st.windowVisible ? "visible" : "hidden"}`,
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
    usage();
  }

  usage();
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
