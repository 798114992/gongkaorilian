import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("root metadata declares mobile viewport, Chinese language and crawlable canonical page", async () => {
  const layout = await read("app/layout.tsx");

  assert.match(layout, /<html lang="zh-CN">/);
  assert.match(layout, /export const viewport: Viewport/);
  assert.match(layout, /width:\s*"device-width"/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(layout, /alternates:\s*\{ canonical: "\/" \}/);
  assert.match(layout, /robots:\s*\{ index: true, follow: true \}/);
  assert.match(layout, /href="#main-content"/);
  assert.match(layout, /id="main-content"/);
});

test("learner shell keeps keyboard focus, touch targets and horizontal overflow safe", async () => {
  const css = await read("app/globals.css");

  assert.match(css, /\.skip-link:focus\s*\{\s*transform:\s*translateY\(0\)/);
  assert.match(css, /\.app-frame button,[\s\S]*min-block-size:\s*44px/);
  assert.match(css, /outline:\s*3px solid #0b5fa5/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
});

test("public learner bundle does not import admin-only Ant Design or spreadsheet code", async () => {
  const learnerFiles = await Promise.all([
    read("app/page.tsx"),
    read("app/DailyPracticeApp.tsx"),
    read("app/AudioHub.tsx"),
    read("app/CommercePaywall.tsx"),
  ]);
  const source = learnerFiles.join("\n");

  assert.doesNotMatch(source, /from\s+["']antd["']/);
  assert.doesNotMatch(source, /@ant-design\//);
  assert.doesNotMatch(source, /from\s+["']xlsx["']/);
  assert.doesNotMatch(source, /import\(["']xlsx["']\)/);
});

test("operator question images have alternate text and defer off-screen loading", async () => {
  const app = await read("app/DailyPracticeApp.tsx");
  const images = [...app.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);

  assert.ok(images.length > 0);
  for (const image of images) {
    assert.match(image, /\balt=/);
    assert.match(image, /\bloading="lazy"/);
  }
});

test("learner form controls have an explicit or wrapping accessible label", async () => {
  const sources = await Promise.all([
    read("app/DailyPracticeApp.tsx"),
    read("app/AudioHub.tsx"),
  ]);

  for (const source of sources) {
    const tokens = source.match(/<\/?label\b[^>]*>|<(?:input|select|textarea)\b[^>]*>/gs) ?? [];
    let labelDepth = 0;
    let controlCount = 0;
    for (const token of tokens) {
      if (/^<label\b/.test(token)) {
        labelDepth += 1;
      } else if (/^<\/label/.test(token)) {
        labelDepth = Math.max(0, labelDepth - 1);
      } else {
        controlCount += 1;
        const explicitlyNamed = /\baria-label(?:ledby)?=/.test(token);
        assert.ok(labelDepth > 0 || explicitlyNamed, `unlabelled learner control: ${token.slice(0, 120)}`);
      }
    }
    assert.ok(controlCount > 0);
  }
});

test("custom learner dialogs expose modal semantics and a visible title", async () => {
  const app = await read("app/DailyPracticeApp.tsx");
  const dialogs = [...app.matchAll(/<div\b[^>]*role="dialog"[^>]*>/g)].map((match) => match[0]);

  assert.equal(dialogs.length, 3);
  for (const dialog of dialogs) {
    assert.match(dialog, /aria-modal="true"/);
    const titleId = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(titleId, `dialog missing aria-labelledby: ${dialog}`);
    assert.match(app, new RegExp(`<h2 id="${titleId}"`));
  }
});
