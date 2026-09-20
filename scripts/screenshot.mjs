import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const CHROME_PATH = "/home/mcocdaa/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const PORT = 9222;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const targetUrl = args[0] || "http://localhost:8799/#/";
  const outFile = args[1] || "/tmp/screenshot.png";
  const clickSelector = args[2];
  const waitMs = Number(args[3] || 2000);

  const chromeProc = spawn(CHROME_PATH, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1280,1050",
  ]);

  try {
    let pageWsUrl = null;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        if (res.ok) {
          const list = await res.json();
          const page = list.find((item) => item.type === "page");
          if (page && page.webSocketDebuggerUrl) {
            pageWsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}
      await sleep(100);
    }

    if (!pageWsUrl) {
      throw new Error("Could not find page target in Chrome");
    }

    const ws = new WebSocket(pageWsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (evt) => {
          const data = JSON.parse(evt.data);
          if (data.id === id) {
            ws.removeEventListener("message", handler);
            if (data.error) reject(data.error);
            else resolve(data.result);
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("DOM.enable");
    await send("Runtime.enable");

    // Navigate to target URL
    await send("Page.navigate", { url: targetUrl });

    // Wait for React to mount, fetch API data and render
    await sleep(waitMs);

    if (clickSelector) {
      await send("Runtime.evaluate", {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(clickSelector)});
            if (el) { el.click(); return true; }
            return false;
          })()
        `,
      });
      await sleep(600);
    }

    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    const buffer = Buffer.from(screenshot.data, "base64");
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, buffer);
    console.log(`Saved screenshot (${buffer.length} bytes) to ${outFile}`);

    ws.close();
  } finally {
    chromeProc.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
