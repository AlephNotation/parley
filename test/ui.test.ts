import { describe, expect, test } from "bun:test";
import { invitePage, homePage, threadPage } from "../src/ui";

describe("page source", () => {
  test("pages are self-contained: no external scripts, stylesheets or fonts", () => {
    for (const page of [threadPage, homePage, invitePage]) {
      expect(page).not.toMatch(/<script[^>]+src=/i);
      expect(page).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
      expect(page).not.toMatch(/@import|@font-face|url\(\s*["']?https?:/i);
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
    }
  });

  test("the room page never builds markup from strings", () => {
    // Message text is untrusted: it must only ever reach the page through textContent and DOM nodes.
    expect(threadPage).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/);
  });

  test("the room page has the audience picker and sends it with a message", () => {
    expect(threadPage).toContain('<select id="to">');
    expect(threadPage).toContain('{ fyi: true }');
    expect(threadPage).toMatch(/api\("\/api\/messages", Object\.assign\(\{ body \}, audienceBody\(\)\)\)/);
  });
});
