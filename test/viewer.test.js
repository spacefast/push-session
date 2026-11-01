import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderSessionBundle } from "../src/render.js";

function waitFor(window, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new window.MutationObserver(() => {
      if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Viewer did not reach expected state: ${window.document.body.textContent.slice(-1000)}`));
    }, 5000);
    observer.observe(window.document, { childList: true, subtree: true, attributes: true });
  });
}

function fixture(context, fetchPage, search = "") {
  const bundle = renderSessionBundle({ agent: "claude", agentLabel: "Claude Code", id: "paged", title: "Paged session" }, [
    { role: "user", content: "First page prompt" },
    { role: "assistant", content: "Second page reply" },
    { role: "user", content: "Third page follow-up" },
  ], { pageItems: 1 });
  const pages = bundle.files.slice(1).map((file) => JSON.parse(file.content));
  const requests = [];
  const dom = new JSDOM(bundle.files[0].content, {
    url: `https://sessions.example/sessions/paged/${search}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false });
      window.fetch = async (url, options) => {
        const index = Number(/(\d+)\.json$/.exec(url)[1]) - 1;
        requests.push(index + 1);
        return fetchPage ? fetchPage(index, pages[index], options) : { ok: true, json: async () => pages[index] };
      };
    },
  });
  context.after(() => dom.window.close());
  const { window } = dom;
  const document = window.document;
  const next = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Next →").click();
  const previous = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "← Previous").click();
  const content = () => document.querySelector(".timeline")?.textContent || "";
  return { window, document, requests, next, previous, content };
}

test("published viewer deep-links pages, retries failures, and keeps only the current page", async (context) => {
  let failThird = true;
  const view = fixture(context, async (index, page) => {
    if (index === 2 && failThird) return { ok: false, status: 503 };
    return { ok: true, json: async () => page };
  }, "?__=share-token&page=2#transcript");
  await waitFor(view.window, () => view.content().includes("Second page reply"));
  assert.deepEqual(view.requests, [2]);
  assert.equal(view.content().includes("First page prompt"), false);
  view.next();
  await waitFor(view.window, () => view.document.querySelector('[role="alert"]'));
  assert.match(view.document.querySelector('[role="alert"]').textContent, /page 3 \(503\)/);
  assert.equal(new URL(view.window.location.href).searchParams.get("__"), "share-token");
  assert.equal(new URL(view.window.location.href).hash, "#transcript");
  failThird = false;
  [...view.document.querySelectorAll("button")].find((button) => button.textContent === "Try again").click();
  await waitFor(view.window, () => view.content().includes("Third page follow-up"));
  assert.equal(view.content().includes("Second page reply"), false);
  assert.equal([...view.document.querySelectorAll("button")].find((button) => button.textContent === "Next →").disabled, true);
  view.previous();
  await waitFor(view.window, () => view.content().includes("Second page reply"));
  view.window.history.back();
  await waitFor(view.window, () => view.content().includes("Third page follow-up"));
  const input = view.document.querySelector('[aria-label="Page number"]');
  input.value = "1";
  input.closest("form").dispatchEvent(new view.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(view.window, () => view.content().includes("First page prompt"));
  assert.equal(new URL(view.window.location.href).searchParams.has("page"), false);
  assert.equal([...view.document.querySelectorAll("button")].find((button) => button.textContent === "← Previous").disabled, true);
});

test("leaving a loading page aborts it and ignores its late response", async (context) => {
  let finishSecond;
  let secondSignal;
  const view = fixture(context, async (index, page, options) => {
    if (index === 1) {
      secondSignal = options.signal;
      await new Promise((resolve) => { finishSecond = resolve; });
    }
    return { ok: true, json: async () => page };
  });
  await waitFor(view.window, () => view.content().includes("First page prompt"));
  view.next();
  await waitFor(view.window, () => view.document.querySelector('[role="status"]')?.textContent.includes("page 2"));
  view.next();
  await waitFor(view.window, () => view.content().includes("Third page follow-up"));
  assert.equal(secondSignal.aborted, true);
  finishSecond();
  await new Promise(setImmediate);
  assert.equal(view.content().includes("Second page reply"), false);
  assert.match(view.content(), /Third page follow-up/);
  assert.equal(new URL(view.window.location.href).searchParams.get("page"), "3");
});
