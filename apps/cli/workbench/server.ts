import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import { buildQuestionEnvelope } from "../turn/index.js"
import { runTurn } from "../turn/turn-run.js"
import type { TurnRunResult } from "../turn/turn-run.js"

// The Workbench is intentionally plain HTTP on loopback. The __Host- cookie
// prefix would require Secure and browsers would reject it on this surface.
const AUTH_COOKIE = "digital_employee_workbench"
const MAX_BODY_BYTES = 32 * 1024
const MAX_MESSAGE_CHARACTERS = 20_000
const MAX_ID_CHARACTERS = 256
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1"])

export interface WorkbenchPosition {
  id: string
  name: string
  reportTo: string | null
}

export interface WorkbenchTurnInput {
  workspace: string
  positionId: string
  envelopeText: string
  writeEvent: (line: string) => void
  writeDiagnostic: (line: string) => void
}

export type WorkbenchTurnExecutor = (
  input: WorkbenchTurnInput,
) => Promise<TurnRunResult>

export interface WorkbenchServer extends Server {
  readonly host: string
}

const WORKBENCH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Digital Employee Workbench</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <header><p class="eyebrow">LOCAL AI TEAM</p><h1>Digital Employee Workbench</h1><p>Choose a position and start a bounded, evidence-backed turn.</p></header>
    <section class="workspace">
      <aside><h2>Positions</h2><div id="positions" aria-live="polite"></div></aside>
      <article>
        <div id="identity"><h2>Select a position</h2><p>Every turn uses that position's Context and Authority Scope.</p></div>
        <div id="thread" aria-live="polite"></div>
        <form id="composer"><textarea id="message" maxlength="20000" required placeholder="Ask this position to do one thing…"></textarea><button type="submit">Send</button></form>
      </article>
    </section>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>`

const WORKBENCH_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#090b10;color:#f6f7fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#20263a 0,#0d1018 45%,#090b10 100%)}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:48px 0}.eyebrow{color:#8ba5ff;letter-spacing:.18em;font-weight:700;font-size:.72rem}h1{font-size:clamp(2rem,5vw,4rem);margin:.2em 0}header>p:last-child{color:#aeb5c7}.workspace{display:grid;grid-template-columns:260px 1fr;min-height:560px;margin-top:36px;border:1px solid #2b3142;border-radius:20px;overflow:hidden;background:#10131cdd;box-shadow:0 24px 80px #0008}aside{padding:24px;border-right:1px solid #2b3142}article{display:flex;flex-direction:column;padding:28px}.position{display:block;width:100%;padding:12px;margin:8px 0;border:1px solid #30384d;border-radius:12px;background:#171c29;color:inherit;text-align:left}.position[aria-current=true]{border-color:#7b97ff;background:#202a46}.position small{display:block;color:#939db5;margin-top:4px}#thread{flex:1;padding:20px 0}.message{max-width:80%;padding:14px 16px;margin:12px 0;border-radius:16px;background:#1a2030;white-space:pre-wrap}.message.user{margin-left:auto;background:#3156c8}.message.error{border:1px solid #9b3e57}form{display:flex;gap:12px}textarea{flex:1;min-height:76px;resize:vertical;border:1px solid #35405a;border-radius:14px;background:#0d111a;color:inherit;padding:14px}button{cursor:pointer;border:0;border-radius:12px;background:#6e8cff;color:#081024;font-weight:800;padding:0 20px}button:disabled,textarea:disabled{opacity:.55}@media(max-width:720px){.workspace{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #2b3142}main{padding-top:24px}}`

const WORKBENCH_JS = `(() => {
  const positionsNode = document.querySelector('#positions');
  const identityNode = document.querySelector('#identity');
  const threadNode = document.querySelector('#thread');
  const form = document.querySelector('#composer');
  const message = document.querySelector('#message');
  const send = form.querySelector('button');
  let selected;
  let conversationRef;
  const append = (text, kind) => { const node=document.createElement('div'); node.className='message '+kind; node.textContent=text; threadNode.append(node); node.scrollIntoView({block:'end'}); };
  const choose = (position, button) => { selected=position; conversationRef=crypto.randomUUID(); document.querySelectorAll('.position').forEach((node)=>node.setAttribute('aria-current','false')); button.setAttribute('aria-current','true'); identityNode.replaceChildren(); const title=document.createElement('h2'); title.textContent=position.name; const detail=document.createElement('p'); detail.textContent='@'+position.id+(position.reportTo ? ' · reports to @'+position.reportTo : ' · organization owner'); identityNode.append(title,detail); threadNode.replaceChildren(); message.focus(); };
  fetch('/v1/positions').then(async (response) => { if(!response.ok) throw new Error('Position catalog unavailable'); return response.json(); }).then(({positions}) => positions.forEach((position) => { const button=document.createElement('button'); button.type='button'; button.className='position'; button.setAttribute('aria-current','false'); const name=document.createTextNode(position.name); const detail=document.createElement('small'); detail.textContent='@'+position.id; button.append(name,detail); button.addEventListener('click',()=>choose(position,button)); positionsNode.append(button); })).catch((error)=>{positionsNode.textContent=error.message;});
  form.addEventListener('submit', async (event) => { event.preventDefault(); const text=message.value.trim(); if(!selected || !text) return; append(text,'user'); message.value=''; message.disabled=true; send.disabled=true; try { const response=await fetch('/v1/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({positionId:selected.id,message:text,conversationRef})}); const result=await response.json(); if(!response.ok) throw new Error(result.error || 'Turn failed'); const output=result.output; append(typeof output==='string' ? output : (output && typeof output.answer==='string' ? output.answer : JSON.stringify(output,null,2)),'assistant'); } catch(error) { append(error instanceof Error ? error.message : 'Turn failed','error'); } finally { message.disabled=false; send.disabled=false; message.focus(); } });
})();`

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  })
  response.end(body)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8")
}

function firstHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

function validToken(received: string | undefined, expected: string): boolean {
  if (!received) return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function authenticated(request: IncomingMessage, token: string): boolean {
  const cookie = firstHeader(request, "cookie")
  if (!cookie) return false
  const values = cookie.split(";").map((entry) => entry.trim())
  const prefix = `${AUTH_COOKIE}=`
  const matches = values.filter((entry) => entry.startsWith(prefix))
  return matches.length === 1 && validToken(matches[0]!.slice(prefix.length), token)
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const host = firstHeader(request, "host")
  if (!host) return undefined
  let expected: URL
  try {
    expected = new URL(`http://${host}`)
  } catch {
    return undefined
  }
  if (!LOOPBACK_HOSTS.has(expected.hostname)) return undefined
  return expected.origin
}

function sameOrigin(request: IncomingMessage): boolean {
  const expected = requestOrigin(request)
  const origin = firstHeader(request, "origin")
  if (!expected || !origin) return false
  try {
    return new URL(origin).origin === expected
  } catch {
    return false
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error("request_body_too_large")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

function exactTurnRequest(value: unknown): value is {
  positionId: string
  message: string
  conversationRef: string
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(",") !==
    "conversationRef,message,positionId"
  ) return false
  return [record.positionId, record.conversationRef].every(
    (item) => typeof item === "string" && item.length > 0 && item.length <= MAX_ID_CHARACTERS,
  ) && typeof record.message === "string" && record.message.trim().length > 0 &&
    record.message.length <= MAX_MESSAGE_CHARACTERS
}

function terminalProjection(
  event: Record<string, unknown> | undefined,
  positionId: string,
  conversationRef: string,
): Record<string, unknown> | undefined {
  if (event?.type === "run.completed") {
    return {
      status: "completed",
      positionId,
      conversationRef,
      output: event.output,
    }
  }
  if (event?.type === "run.failed") {
    const error = event.error
    const code = error && typeof error === "object" && !Array.isArray(error) &&
      typeof (error as Record<string, unknown>).code === "string"
      ? (error as Record<string, unknown>).code
      : "engine.turn_failed"
    return { status: "failed", positionId, conversationRef, error: { code } }
  }
  return undefined
}

export function createWorkbenchServer(options: {
  workspace: string
  positions: readonly WorkbenchPosition[]
  executeTurn?: WorkbenchTurnExecutor
  newId?: () => string
  host?: string
}): WorkbenchServer {
  const host = options.host ?? "127.0.0.1"
  if (!LOOPBACK_BIND_HOSTS.has(host)) throw new TypeError("workbench_loopback_required")
  if (options.positions.length === 0) throw new TypeError("workbench_positions_required")
  const positionIds = new Set(options.positions.map((position) => position.id))
  if (positionIds.size !== options.positions.length) {
    throw new TypeError("workbench_positions_invalid")
  }
  const token = randomBytes(32).toString("base64url")
  const executeTurn = options.executeTurn ?? runTurn
  const newId = options.newId ?? randomUUID
  const activeConversations = new Set<string>()

  const server = createServer(async (request, response) => {
    const authority = request.url ?? "/"
    if (/^(?:https?:)?\/\//i.test(authority)) {
      sendJson(response, 400, { error: "absolute_form_denied" })
      request.resume()
      return
    }
    const pathname = new URL(authority, "http://localhost").pathname
    const securityHeaders = {
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    }
    try {
      if (request.method === "GET" && pathname === "/") {
        send(response, 200, WORKBENCH_HTML, "text/html; charset=utf-8", {
          ...securityHeaders,
          "set-cookie": `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
        })
        return
      }
      if (request.method === "GET" && pathname === "/styles.css") {
        send(response, 200, WORKBENCH_CSS, "text/css; charset=utf-8", securityHeaders)
        return
      }
      if (request.method === "GET" && pathname === "/app.js") {
        send(response, 200, WORKBENCH_JS, "text/javascript; charset=utf-8", securityHeaders)
        return
      }
      if (!authenticated(request, token)) {
        sendJson(response, 401, { error: "unauthorized" })
        request.resume()
        return
      }
      if (request.method === "GET" && pathname === "/v1/positions") {
        sendJson(response, 200, { positions: options.positions })
        return
      }
      if (request.method !== "POST" || pathname !== "/v1/turns") {
        sendJson(response, 404, { error: "not_found" })
        request.resume()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: "cross_origin_denied" })
        request.resume()
        return
      }
      const mediaType = firstHeader(request, "content-type")
      if (!mediaType || !JSON_MEDIA_TYPE.test(mediaType.trim())) {
        sendJson(response, 415, { error: "unsupported_media_type" })
        request.resume()
        return
      }
      const body = await readJson(request)
      if (!exactTurnRequest(body)) {
        sendJson(response, 400, { error: "invalid_request" })
        return
      }
      if (!positionIds.has(body.positionId)) {
        sendJson(response, 404, { error: "position_not_found" })
        return
      }
      if (activeConversations.has(body.conversationRef)) {
        sendJson(response, 409, { error: "conversation_busy" })
        return
      }
      activeConversations.add(body.conversationRef)
      try {
        const envelope = buildQuestionEnvelope({
          workspace: options.workspace,
          positionId: body.positionId,
          question: body.message.trim(),
          turnId: newId(),
          conversationRef: body.conversationRef,
        })
        const events: Record<string, unknown>[] = []
        const diagnostics: string[] = []
        const result = await executeTurn({
          workspace: options.workspace,
          positionId: body.positionId,
          envelopeText: JSON.stringify(envelope),
          writeEvent: (line) => {
            const event = JSON.parse(line) as unknown
            if (event && typeof event === "object" && !Array.isArray(event)) {
              events.push(event as Record<string, unknown>)
            }
          },
          writeDiagnostic: (line) => diagnostics.push(line.slice(0, 1024)),
        })
        const terminal = events
          .slice()
          .reverse()
          .find(
            (event) => event.type === "run.completed" || event.type === "run.failed",
          )
        const projection = terminalProjection(
          terminal,
          body.positionId,
          body.conversationRef,
        )
        if (!result.terminalEmitted || !projection) {
          sendJson(response, 502, {
            error: "turn_indeterminate",
            diagnostic: diagnostics[0]?.split(":").slice(0, 2).join(":") ?? "unavailable",
          })
          return
        }
        sendJson(response, projection.status === "completed" ? 200 : 422, projection)
      } finally {
        activeConversations.delete(body.conversationRef)
      }
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === "request_body_too_large" ? 413 : 400, {
        error: error instanceof Error && error.message === "request_body_too_large"
          ? "request_body_too_large"
          : "invalid_request",
      })
    }
  }) as WorkbenchServer
  Object.defineProperty(server, "host", { value: host, enumerable: true })
  return server
}
